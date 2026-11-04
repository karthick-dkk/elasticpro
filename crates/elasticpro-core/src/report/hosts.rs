//! Volume by host (docs/REPORT-TYPES.md "Volume by host"): the collection's requests and
//! pages, the day files it keeps, the ClientID/branch fill, and the workbook, CSV and view
//! read back from those files.
//!
//! Pure or blocking file I/O only — nothing here sends a request (`run_types` does, under
//! the volume run's rules) and nothing here holds a cluster-day: a page of at most
//! `PAGE_SIZE_MAX` rows is appended to the day's `.part` file as its own gzip member, a
//! checkpoint (`<day>.partial.json`) says how far the file got, and the day file is renamed
//! into place only when its last page is in. A restart or a failed page resumes from the
//! checkpoint (`HostsDir::resume`); a reader streams a day file a line at a time.
//!
//! ```text
//!   <data>/volume/<cluster>/hosts/<YYYY-MM-DD>.json.gz          gzip (one member per page), one JSON per line:
//!                                                             {"header":{…}}  rows…  {"end":{rows, pages, incomplete, notes}}
//!   <data>/volume/<cluster>/hosts/<YYYY-MM-DD>.json.gz.part     the same, while it is being collected
//!   <data>/volume/<cluster>/hosts/<YYYY-MM-DD>.partial.json     the checkpoint: after_key, rows, pages, page size, failures
//! ```
//!
//! The stored rows keep what Elasticsearch said; `fill_client_branch` fills ClientID and
//! branch when a report or the view shows them — one function for the workbook, the CSV and
//! `HOSTS_QUERY`.

use super::build::{csv_escape, GB, NOT_MEASURED};
use super::period::Period;
use super::xlsx::{Cell, StreamBook};
use crate::http::EsRequest;
use crate::volume::collect::{self, Indices};
use crate::volume::schedule::{day_key, parse_day};
use crate::volume::VolumeSettings;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// The operators' script's metadata fields, in its order (`UI_REPORT_HOSTS_FIELDS`).
pub const DEFAULT_FIELDS: &[&str] = &[
    "parser_tag", "fwdtag", "fwd_tag", "src_ip", "tag1", "zone", "ClientID", "ClientName", "branch", "logtag",
    "log_type", "observer_hostname",
];
/// Rows one composite page asks for at first, and the least it halves to.
pub const PAGE_SIZE_MAX: usize = 1000;
pub const PAGE_SIZE_MIN: usize = 100;
pub const DEFAULT_MAX_PAGES: u64 = 2000;
pub const DEFAULT_KEEP_MONTHS: u32 = 3;
pub const DEFAULT_REQUEST_TIMEOUT_S: u64 = 120;
pub const DEFAULT_PAGE_PAUSE_MS: u64 = 200;
pub const DEFAULT_MAX_MINUTES: u64 = 120;
/// Ticks a failed day is tried again on before it waits for a person (*Run now*).
pub const MAX_FAILED_TICKS: u32 = 3;
/// Clusters one *Run now* may name (`too_many_clusters`).
pub const MAX_RUN_CLUSTERS: usize = 5;
/// Rows `HOSTS_QUERY` hands back at once, and the deepest it pages a sorted view.
pub const QUERY_LIMIT_MAX: usize = 200;
pub const QUERY_DEPTH_MAX: usize = 100_000;
/// What the view and the sheets call a row with no value for the host field.
pub const NO_HOST: &str = "(no host)";
pub const NOT_IN_MAPPING: &str = "not in the mapping";
pub const ORIGIN: &str = "volume-hosts";

/// The settings that shape the collection and the reports, from config.txt.
#[derive(Clone, Debug, PartialEq)]
pub struct HostsConfig {
    /// The metadata fields, in their column order; ClientID and branch are always among them.
    pub fields: Vec<String>,
    pub client_id_field: String,
    pub branch_field: String,
    pub branch_default: String,
    pub max_pages: u64,
    pub keep_months: u32,
    pub request_timeout_ms: u64,
    pub page_pause_ms: u64,
    pub max_minutes: u64,
    /// The most one page may answer before the next is asked at half the size.
    pub page_bytes: usize,
}

impl Default for HostsConfig {
    fn default() -> HostsConfig {
        HostsConfig::from_settings(&crate::settings::Settings::default(), 16 * 1024 * 1024)
    }
}

impl HostsConfig {
    pub fn from_settings(s: &crate::settings::Settings, page_bytes: usize) -> HostsConfig {
        let text = |k: &str, d: &str| s.text(k).map(str::trim).filter(|v| !v.is_empty()).unwrap_or(d).to_string();
        let int = |k: &str, d: u64| s.text(k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d);
        let client_id_field = text("UI_REPORT_CLIENT_ID_FIELD", "ClientID");
        let branch_field = text("UI_REPORT_BRANCH_FIELD", "branch");
        let mut fields: Vec<String> = match s.text("UI_REPORT_HOSTS_FIELDS") {
            Some(v) => super::schedule::comma_list(v),
            None => DEFAULT_FIELDS.iter().map(|f| f.to_string()).collect(),
        };
        for f in [&client_id_field, &branch_field] {
            if !fields.contains(f) {
                fields.push(f.clone());
            }
        }
        HostsConfig {
            fields, client_id_field, branch_field,
            branch_default: text("UI_REPORT_BRANCH_DEFAULT", "DC"),
            max_pages: int("UI_REPORT_HOSTS_MAX_PAGES", DEFAULT_MAX_PAGES).max(1),
            keep_months: int("UI_REPORT_HOSTS_KEEP_MONTHS", DEFAULT_KEEP_MONTHS as u64).clamp(1, 13) as u32,
            request_timeout_ms: int("UI_REPORT_HOSTS_REQUEST_TIMEOUT_S", DEFAULT_REQUEST_TIMEOUT_S) * 1000,
            page_pause_ms: int("UI_REPORT_HOSTS_PAGE_PAUSE_MS", DEFAULT_PAGE_PAUSE_MS),
            max_minutes: int("UI_REPORT_HOSTS_MAX_MINUTES", DEFAULT_MAX_MINUTES).max(1),
            page_bytes: page_bytes.max(64 * 1024),
        }
    }
}

/* ------------------------------------------ fields ------------------------------------------ */

/// The names one cluster's fields resolved to (`_field_caps`, the volume rows' rule).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub source_host: Option<String>,
    pub event_size: Option<String>,
    pub sub_size: Option<String>,
    /// Per metadata field (`HostsConfig::fields`, in order): what it resolved to, or `None`.
    pub meta: Vec<Option<String>>,
    /// What did not resolve and why, said once in the sheet's header note.
    #[serde(default)]
    pub notes: Vec<String>,
}

pub fn resolve(fc: &Value, s: &VolumeSettings, fields: &[String]) -> Resolved {
    let rows = collect::resolve_rows(fc, s);
    let pick = |key: &str| rows.iter().find(|r| r.key == key).cloned().unwrap_or_default();
    let mut out = Resolved::default();
    for (key, label, slot) in [("sourceHost", "source host", &mut out.source_host), ("eventSize", "event size", &mut out.event_size),
                               ("subSize", "forwarded size", &mut out.sub_size)] {
        let r = pick(key);
        if r.resolved.is_none() {
            out.notes.push(format!("{label}: {}", r.note));
        }
        *slot = r.resolved;
    }
    let mut missing = vec![];
    for f in fields {
        let r = collect::resolve_row(fc, f, std::slice::from_ref(f), false);
        if r.resolved.is_none() {
            missing.push(f.clone());
        }
        out.meta.push(r.resolved);
    }
    if !missing.is_empty() {
        out.notes.push(format!("{NOT_IN_MAPPING}: {}", missing.join(", ")));
    }
    out
}

fn req(cluster: &str, method: &str, path: String, body: Option<String>, timeout_ms: u64) -> EsRequest {
    EsRequest {
        cluster_id: cluster.to_string(),
        method: method.into(),
        path,
        body,
        timeout_ms: Some(timeout_ms),
        allow_writes: false,
        origin: Some(ORIGIN.into()),
        class: crate::gate::Class::Background,
        ..Default::default()
    }
}

/// `_field_caps` for the volume rows (source host, event size, forwarded size), the metadata
/// fields and their `.keyword`, and the time field when some index is split by time.
pub fn field_caps_request(cluster: &str, ind: &Indices, s: &VolumeSettings, fields: &[String], time: bool, timeout_ms: u64) -> EsRequest {
    let mut names = collect::field_caps_fields(s, time);
    for f in fields {
        for n in [f.clone(), format!("{f}.keyword")] {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    req(cluster, "GET", format!("/{}/_field_caps?fields={}&ignore_unavailable=true", ind.expr(), names.join(",")), None, timeout_ms)
}

/* ------------------------------------------ pages ------------------------------------------ */

/// One page of the day's composite aggregation: `_index` × host, the sums and, per metadata
/// field, the value most of the host's documents carry (`terms size 1`). `query` is the
/// Daily record's day (`collect::day_query`).
pub fn composite_body(query: &Value, r: &Resolved, size: usize, after: Option<&Value>) -> Value {
    let mut sources = vec![json!({ "i": { "terms": { "field": "_index" } } })];
    if let Some(h) = &r.source_host {
        sources.push(json!({ "h": { "terms": { "field": h, "missing_bucket": true } } }));
    }
    let mut comp = json!({ "size": size, "sources": sources });
    if let Some(a) = after {
        comp["after"] = a.clone();
    }
    let mut aggs = Map::new();
    if let Some(f) = &r.event_size {
        aggs.insert("ev".into(), json!({ "sum": { "field": f } }));
        aggs.insert("m_ev".into(), json!({ "missing": { "field": f } }));
    }
    if let Some(f) = &r.sub_size {
        aggs.insert("sub".into(), json!({ "sum": { "field": f } }));
    }
    for (i, m) in r.meta.iter().enumerate() {
        if let Some(f) = m {
            aggs.insert(format!("md{i}"), json!({ "terms": { "field": f, "size": 1 } }));
        }
    }
    let mut h = json!({ "composite": comp });
    if !aggs.is_empty() {
        h["aggs"] = Value::Object(aggs);
    }
    json!({ "size": 0, "track_total_hits": false, "query": query, "aggs": { "h": h } })
}

/// The search thread pool, before a cluster starts and every `control::POOL_CHECK_EVERY`
/// pages (docs/REPORT-TYPES.md "Concurrency").
pub fn pool_request(cluster: &str, timeout_ms: u64) -> EsRequest {
    req(cluster, "GET", "/_cat/thread_pool/search?format=json&h=node_name,active,queue,queue_size,rejected".into(), None, timeout_ms)
}

/// The search one page is: the pattern in the path, the day in the query.
pub fn page_request(cluster: &str, ind: &Indices, body: &Value, timeout_ms: u64) -> EsRequest {
    req(cluster, "POST", format!("/{}/{}", ind.expr(), collect::SEARCH_QS), Some(body.to_string()), timeout_ms)
}

/// One row: a day × index × source host, as Elasticsearch answered it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HostRow {
    #[serde(rename = "i")]
    pub index: String,
    #[serde(rename = "h", default)]
    pub host: Option<String>,
    #[serde(rename = "d")]
    pub docs: u64,
    /// `None`: the event size field did not resolve — not measured, never 0.
    #[serde(rename = "e", default)]
    pub event_bytes: Option<u64>,
    #[serde(rename = "s", default)]
    pub sub_bytes: Option<u64>,
    /// Documents with no event size.
    #[serde(rename = "me", default)]
    pub event_missing: u64,
    /// Per metadata field of the file's header, its value.
    #[serde(rename = "m", default)]
    pub meta: Vec<Option<String>>,
}

#[derive(Debug, Default)]
pub struct Page {
    pub rows: Vec<HostRow>,
    pub after: Option<Value>,
    /// The last page: fewer buckets than asked for, or no `after_key`.
    pub done: bool,
}

fn key_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn sum(b: &Value, name: &str) -> u64 {
    b.pointer(&format!("/{name}/value")).and_then(Value::as_f64).map(|f| f.max(0.0).round() as u64).unwrap_or(0)
}

/// Read one page's answer. Shards that failed or a time-out are an error (the page is asked
/// again): a short page would be taken for the end, and its rows for the whole.
pub fn read_page(res: &Value, r: &Resolved, size: usize) -> Result<Page, String> {
    if let Some(p) = collect::partial_answer(res) {
        return Err(p.split(':').next().unwrap_or("a partial answer").to_string());
    }
    let h = res.pointer("/aggregations/h").ok_or("the answer has no composite aggregation")?;
    let buckets = h.get("buckets").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut rows = Vec::with_capacity(buckets.len());
    for b in &buckets {
        let Some(index) = b.pointer("/key/i").and_then(key_text) else { continue };
        let host = b.pointer("/key/h").and_then(key_text);
        let meta = (0..r.meta.len()).map(|i| {
            r.meta[i].as_ref()?;
            b.pointer(&format!("/md{i}/buckets/0")).and_then(|t| t.get("key_as_string").or_else(|| t.get("key"))).and_then(key_text)
        }).collect();
        rows.push(HostRow {
            index, host,
            docs: b.get("doc_count").and_then(Value::as_u64).unwrap_or(0),
            event_bytes: r.event_size.as_ref().map(|_| sum(b, "ev")),
            sub_bytes: r.sub_size.as_ref().map(|_| sum(b, "sub")),
            event_missing: b.pointer("/m_ev/doc_count").and_then(Value::as_u64).unwrap_or(0),
            meta,
        });
    }
    let after = h.get("after_key").filter(|v| v.is_object()).cloned();
    let done = buckets.len() < size || after.is_none();
    Ok(Page { rows, after, done })
}

/// The next page's size: halved (down to `PAGE_SIZE_MIN`) when this page's answer was larger
/// than one page may be (`HostsConfig::page_bytes`, a share of the core's memory budget).
pub fn next_page_size(current: usize, body_bytes: u64, allowance: usize) -> usize {
    if body_bytes > allowance as u64 { (current / 2).max(PAGE_SIZE_MIN) } else { current }
}

/* ------------------------------------------ files ------------------------------------------ */

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayHeader {
    pub v: u32,
    pub day: String,
    pub fields: Vec<String>,
    pub resolved: Resolved,
    pub started_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEnd {
    pub rows: u64,
    pub pages: u64,
    /// The page bound was reached: the day has more rows than the file.
    pub incomplete: bool,
    #[serde(default)]
    pub notes: Vec<String>,
    pub collected_at: i64,
}

/// One partition of a day (docs/REPORT-TYPES.md "Concurrency"): a run of the day's indices
/// with its own composite `after_key` stream and its own `.part` file.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartState {
    pub indices: Vec<String>,
    pub after: Option<Value>,
    pub rows: u64,
    pub pages: u64,
    pub page_size: usize,
    /// The `.part` file's length after the last page kept: anything past it is a page whose
    /// checkpoint was never written, and is cut off on resume.
    pub part_bytes: u64,
    pub done: bool,
}

/// How far a day's collection got: written after every page, so a restart or a failure
/// resumes each partition from the page after the last one it kept.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub day: String,
    pub header: DayHeader,
    pub parts: Vec<PartState>,
    /// The page bound was reached: the remaining pages are not asked.
    #[serde(default)]
    pub incomplete: bool,
    pub retries: u64,
    pub updated_at: i64,
    /// The last failure, after its retries; `failed_ticks` counts the ticks it failed on.
    #[serde(default)]
    pub failed: Option<String>,
    #[serde(default)]
    pub failed_at: Option<i64>,
    #[serde(default)]
    pub failed_ticks: u32,
    /// Why it stopped short without failing (the emergency stop, a person, the watchdog).
    #[serde(default)]
    pub interrupted: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

impl Checkpoint {
    pub fn rows(&self) -> u64 {
        self.parts.iter().map(|p| p.rows).sum()
    }
    pub fn pages(&self) -> u64 {
        self.parts.iter().map(|p| p.pages).sum()
    }
    pub fn parts_done(&self) -> usize {
        self.parts.iter().filter(|p| p.done).count()
    }
    /// Every partition has its last page, or the page bound ended the day.
    pub fn finished(&self) -> bool {
        self.incomplete || self.parts.iter().all(|p| p.done)
    }

    /// Whether the timer should take this day up again now: interrupted, or failed fewer
    /// than `MAX_FAILED_TICKS` times and not in the last `wait_ms`.
    pub fn resumable(&self, now: i64, wait_ms: i64) -> bool {
        match &self.failed {
            None => true,
            Some(_) => self.failed_ticks < MAX_FAILED_TICKS && self.failed_at.is_none_or(|t| now - t >= wait_ms),
        }
    }
}

fn gz_member(lines: &mut dyn Iterator<Item = String>) -> Result<Vec<u8>, String> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    for l in lines {
        enc.write_all(l.as_bytes()).map_err(|e| e.to_string())?;
        enc.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    enc.finish().map_err(|e| e.to_string())
}

fn open_private(p: &Path, append: bool) -> Result<std::fs::File, String> {
    let mut o = std::fs::OpenOptions::new();
    o.create(true);
    if append {
        o.append(true);
    } else {
        o.write(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(p).map_err(|e| format!("{}: {e}", p.display()))
}

/// One cluster's day files.
#[derive(Clone, Debug)]
pub struct HostsDir {
    dir: PathBuf,
}

impl HostsDir {
    /// `<volume root>/<escaped cluster id>/hosts`: beside the cluster's volume record.
    pub fn new(volume_root: &Path, cluster: &str) -> HostsDir {
        HostsDir { dir: volume_root.join(crate::fleet::store::escape(cluster)).join("hosts") }
    }

    pub fn final_path(&self, day: &str) -> PathBuf {
        self.dir.join(format!("{day}.json.gz"))
    }
    /// Partition `k`'s pages while the day is collected.
    pub fn part_path(&self, day: &str, k: usize) -> PathBuf {
        self.dir.join(format!("{day}.p{k}.json.gz.part"))
    }
    /// The day file being assembled from its partitions, renamed into place when whole.
    fn assembling_path(&self, day: &str) -> PathBuf {
        self.dir.join(format!("{day}.json.gz.part"))
    }
    pub fn checkpoint_path(&self, day: &str) -> PathBuf {
        self.dir.join(format!("{day}.partial.json"))
    }

    pub fn held(&self, day: &str) -> bool {
        self.final_path(day).is_file()
    }

    pub fn checkpoint(&self, day: &str) -> Option<Checkpoint> {
        std::fs::read(self.checkpoint_path(day)).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    pub fn save_checkpoint(&self, cp: &Checkpoint) -> Result<(), String> {
        crate::volume::store::write_atomic(&self.checkpoint_path(&cp.day), &serde_json::to_vec(cp).map_err(|e| e.to_string())?)
    }

    /// Start a day afresh: one empty `.part` per partition, and the checkpoint. A day file
    /// already held stays until this one replaces it.
    pub fn begin(&self, header: DayHeader, partitions: Vec<Vec<String>>, page_size: usize, now: i64) -> Result<Checkpoint, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700));
        }
        let day = header.day.clone();
        let mut parts = vec![];
        for (k, indices) in partitions.into_iter().enumerate() {
            open_private(&self.part_path(&day, k), false)?.sync_all().map_err(|e| e.to_string())?;
            parts.push(PartState { indices, page_size, ..PartState::default() });
        }
        let cp = Checkpoint { day, header, parts, updated_at: now, ..Checkpoint::default() };
        self.save_checkpoint(&cp)?;
        Ok(cp)
    }

    /// Take a day up where its checkpoint says: each partition's `.part` cut back to the
    /// last page it kept. `Err` when one is shorter than that (gone, or not ours): start
    /// the day afresh.
    pub fn resume(&self, cp: &Checkpoint) -> Result<(), String> {
        for (k, part) in cp.parts.iter().enumerate() {
            let p = self.part_path(&cp.day, k);
            let len = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?.len();
            if len < part.part_bytes {
                return Err(format!("{} is shorter than its checkpoint", p.display()));
            }
            if len > part.part_bytes {
                let f = std::fs::OpenOptions::new().write(true).open(&p).map_err(|e| e.to_string())?;
                f.set_len(part.part_bytes).map_err(|e| e.to_string())?;
                f.sync_all().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// One page of partition `k`: appended to its `.part` as its own gzip member, synced,
    /// then the checkpoint moves past it.
    pub fn append(&self, cp: &mut Checkpoint, k: usize, rows: &[HostRow], after: Option<Value>, done: bool, now: i64) -> Result<(), String> {
        let member = gz_member(&mut rows.iter().map(|r| serde_json::to_string(r).unwrap_or_default()))?;
        let p = self.part_path(&cp.day, k);
        let mut f = open_private(&p, true)?;
        f.write_all(&member).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        let part = cp.parts.get_mut(k).ok_or("no such partition")?;
        part.part_bytes += member.len() as u64;
        part.rows += rows.len() as u64;
        part.pages += 1;
        part.after = after;
        part.done = done;
        cp.updated_at = now;
        cp.failed = None;
        cp.interrupted = None;
        self.save_checkpoint(cp)
    }

    /// Every partition is in: the header, each partition's pages in order (a run of index
    /// names each, so the file stays in index order) and the end line, assembled beside the
    /// day file and renamed into place (atomic — a reader sees the old day file or the new
    /// one, never half of one); then the `.part` files and the checkpoint go.
    pub fn complete(&self, cp: &Checkpoint, end: &DayEnd) -> Result<(), String> {
        let tmp = self.assembling_path(&cp.day);
        {
            let mut out = open_private(&tmp, false)?;
            let head = serde_json::to_string(&json!({ "header": &cp.header })).map_err(|e| e.to_string())?;
            out.write_all(&gz_member(&mut std::iter::once(head))?).map_err(|e| e.to_string())?;
            for (k, part) in cp.parts.iter().enumerate() {
                let f = std::fs::File::open(self.part_path(&cp.day, k)).map_err(|e| e.to_string())?;
                let mut kept = std::io::Read::take(f, part.part_bytes);
                std::io::copy(&mut kept, &mut out).map_err(|e| e.to_string())?;
            }
            let tail = serde_json::to_string(&json!({ "end": end })).map_err(|e| e.to_string())?;
            out.write_all(&gz_member(&mut std::iter::once(tail))?).map_err(|e| e.to_string())?;
            out.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, self.final_path(&cp.day)).map_err(|e| e.to_string())?;
        for k in 0..cp.parts.len() {
            let _ = std::fs::remove_file(self.part_path(&cp.day, k));
        }
        let _ = std::fs::remove_file(self.checkpoint_path(&cp.day));
        Ok(())
    }

    /// A day with nothing to ask (no index counts on it): its file, at once.
    pub fn write_empty(&self, header: DayHeader, notes: Vec<String>, now: i64) -> Result<(), String> {
        let cp = self.begin(header, vec![], PAGE_SIZE_MAX, now)?;
        self.complete(&cp, &DayEnd { rows: 0, pages: 0, incomplete: false, notes, collected_at: now })
    }

    /// Every day this directory has a checkpoint for (being collected, interrupted, failed).
    pub fn checkpoints(&self) -> Vec<Checkpoint> {
        let mut out: Vec<Checkpoint> = std::fs::read_dir(&self.dir).into_iter().flatten().flatten()
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".partial.json")).map(String::from))
            .filter_map(|d| self.checkpoint(&d)).collect();
        out.sort_by(|a, b| a.day.cmp(&b.day));
        out
    }

    /// Remove every file of a day before `oldest`. Returns how many days went.
    pub fn prune(&self, oldest: NaiveDate) -> usize {
        let mut days = std::collections::BTreeSet::new();
        for e in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            let name = e.file_name();
            let Some(n) = name.to_str() else { continue };
            let Some(d) = n.get(..10).and_then(parse_day) else { continue };
            if d < oldest && std::fs::remove_file(e.path()).is_ok() {
                days.insert(d);
            }
        }
        days.len()
    }

    pub fn read(&self, day: &str) -> Option<DayReader> {
        DayReader::open(&self.final_path(day))
    }
}

/// A day file, a line at a time.
pub struct DayReader {
    lines: std::io::Lines<std::io::BufReader<flate2::read::MultiGzDecoder<std::io::BufReader<std::fs::File>>>>,
    pub header: DayHeader,
    pub end: Option<DayEnd>,
}

impl DayReader {
    pub fn open(p: &Path) -> Option<DayReader> {
        let f = std::fs::File::open(p).ok()?;
        let mut lines = std::io::BufReader::new(flate2::read::MultiGzDecoder::new(std::io::BufReader::new(f))).lines();
        let first = lines.next()?.ok()?;
        let v: Value = serde_json::from_str(&first).ok()?;
        let header: DayHeader = serde_json::from_value(v.get("header")?.clone()).ok()?;
        Some(DayReader { lines, header, end: None })
    }

    /// Read to the end and hand back the end line (for the day's flags alone).
    pub fn finish(mut self) -> Option<DayEnd> {
        for _ in self.by_ref() {}
        self.end
    }
}

impl Iterator for DayReader {
    type Item = HostRow;
    fn next(&mut self) -> Option<HostRow> {
        loop {
            let line = self.lines.next()?.ok()?;
            if line.starts_with("{\"end\"") {
                self.end = serde_json::from_str::<Value>(&line).ok().and_then(|v| serde_json::from_value(v.get("end")?.clone()).ok());
                return None;
            }
            if let Ok(r) = serde_json::from_str::<HostRow>(&line) {
                return Some(r);
            }
        }
    }
}

/* ------------------------------------ ClientID and branch ------------------------------------ */

/// A ClientID or branch the script took for none: absent, empty, `__missing__`, `None`, `nan`.
pub fn is_missing(v: Option<&str>) -> bool {
    match v.map(str::trim) {
        None | Some("") | Some("__missing__") => true,
        Some(s) => s.eq_ignore_ascii_case("none") || s.eq_ignore_ascii_case("nan"),
    }
}

/// What a cluster's rows are filled with: the first ClientID of its rows in the period (day,
/// then index order), and the branch for a row that has none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fill {
    pub first_client: Option<String>,
    pub branch_default: String,
}

/// The one fill (docs/REPORT-TYPES.md "ClientID and branch", as the operators' script did
/// it): a missing ClientID takes the cluster's first; a missing branch becomes the default
/// (`DC`). The workbook, the CSV and `HOSTS_QUERY` all show rows through this; the stored
/// rows keep what Elasticsearch said.
pub fn fill_client_branch(client: Option<&str>, branch: Option<&str>, fill: &Fill) -> (Option<String>, String) {
    let c = if is_missing(client) { fill.first_client.clone() } else { client.map(|s| s.trim().to_string()) };
    let b = match branch {
        b if is_missing(b) => fill.branch_default.clone(),
        Some(b) => b.trim().to_string(),
        None => fill.branch_default.clone(),
    };
    (c, b)
}

/// The Summary's Client ID for a cluster: its first ClientID, or its name when no row has one.
pub fn summary_client(fill: &Fill, cluster_name: &str) -> String {
    fill.first_client.clone().unwrap_or_else(|| cluster_name.to_string())
}

/// Where a configured field is in a day file's metadata (its header's fields).
fn positions(cfg_fields: &[String], header: &DayHeader) -> Vec<Option<usize>> {
    cfg_fields.iter().map(|f| header.fields.iter().position(|h| h == f)).collect()
}

/* --------------------------------------- reading back --------------------------------------- */

/// One cluster's day files over a period, as the reports and the view read them.
pub struct ClusterHosts {
    pub id: String,
    pub name: String,
    pub dir: HostsDir,
    pub ind: Option<Indices>,
    /// Why the cluster could not be collected (it has what the files already held).
    pub failure: Option<String>,
}

/// One row as shown: the stored row with its day, source and filled ClientID/branch, its
/// metadata in the configured order, and whether its day is incomplete.
#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub day: String,
    pub source: String,
    pub row: HostRow,
    pub meta: Vec<Option<String>>,
    pub client: Option<String>,
    pub branch: String,
    pub incomplete: bool,
}

/// The days of a period a cluster holds, with each day's end line (read once per file).
pub fn day_flags(c: &ClusterHosts, p: &Period) -> Vec<(String, Option<DayEnd>, Option<Checkpoint>)> {
    p.days().into_iter().map(|d| {
        let k = day_key(d);
        let end = c.dir.read(&k).and_then(DayReader::finish);
        let cp = if end.is_none() { c.dir.checkpoint(&k) } else { None };
        (k, end, cp)
    }).collect()
}

impl ClusterHosts {
    /// The cluster's first ClientID in the period, rows in day and index order (a day file
    /// is in composite order: index, then host).
    pub fn fill(&self, cfg: &HostsConfig, p: &Period) -> Fill {
        let mut first = None;
        'days: for d in p.days() {
            let Some(r) = self.dir.read(&day_key(d)) else { continue };
            let Some(at) = r.header.fields.iter().position(|f| *f == cfg.client_id_field) else { continue };
            for row in r {
                if let Some(v) = row.meta.get(at).cloned().flatten().filter(|v| !is_missing(Some(v))) {
                    first = Some(v.trim().to_string());
                    break 'days;
                }
            }
        }
        Fill { first_client: first, branch_default: cfg.branch_default.clone() }
    }

    /// Every row of the period, day by day, streamed into `f`.
    pub fn each(&self, cfg: &HostsConfig, p: &Period, fill: &Fill, mut f: impl FnMut(Shown) -> Result<(), String>) -> Result<(), String> {
        let ci = cfg.fields.iter().position(|x| *x == cfg.client_id_field);
        let bi = cfg.fields.iter().position(|x| *x == cfg.branch_field);
        for d in p.days() {
            let k = day_key(d);
            let Some(mut r) = self.dir.read(&k) else { continue };
            let pos = positions(&cfg.fields, &r.header);
            // The end line comes last; whether the day is incomplete is known only there, so
            // the day is read twice when it is (rare: the page bound).
            let incomplete = self.dir.read(&k).and_then(DayReader::finish).is_some_and(|e| e.incomplete);
            for row in r.by_ref() {
                let meta: Vec<Option<String>> = pos.iter().map(|p| p.and_then(|i| row.meta.get(i).cloned().flatten())).collect();
                let get = |i: Option<usize>| i.and_then(|i| meta.get(i).cloned().flatten());
                let (client, branch) = fill_client_branch(get(ci).as_deref(), get(bi).as_deref(), fill);
                let source = self.ind.as_ref().map(|ind| ind.source_of(&row.index)).unwrap_or_else(|| row.index.clone());
                f(Shown { day: k.clone(), source, row, meta, client, branch, incomplete })?;
            }
        }
        Ok(())
    }
}

/// Bytes as GB (1024³), not rounded: a host's share of a day is often far below 0.01 GB.
fn gb_cell(v: Option<u64>) -> Cell {
    match v {
        Some(b) => Cell::Dec(b as f64 / GB),
        None => Cell::text(NOT_MEASURED),
    }
}

fn add(a: &mut Option<u64>, b: Option<u64>, seen: &mut bool) {
    // Unknown is not zero: one row not measured makes the sum not measured.
    match (*seen, b) {
        (false, x) => {
            *a = x;
            *seen = true;
        }
        (true, Some(x)) => *a = a.map(|s| s + x),
        (true, None) => *a = None,
    }
}

/// A sum of documents and sizes; `None` sizes stay "not measured".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sums {
    pub docs: u64,
    pub event_bytes: Option<u64>,
    pub sub_bytes: Option<u64>,
    seen: bool,
}

impl Sums {
    pub fn add(&mut self, r: &HostRow) {
        self.docs += r.docs;
        let mut s1 = self.seen;
        add(&mut self.event_bytes, r.event_bytes, &mut s1);
        let mut s2 = self.seen;
        add(&mut self.sub_bytes, r.sub_bytes, &mut s2);
        self.seen = true;
    }
}

/// The Summary of one cluster: per (day, ClientID, branch) — the script's Monthly_Summary
/// groups by those after the fill — and the cluster's total.
pub struct Summary {
    pub client: String,
    pub groups: BTreeMap<(String, String, String), Sums>,
    pub total: Sums,
}

pub fn summarize(c: &ClusterHosts, cfg: &HostsConfig, p: &Period, fill: &Fill) -> Result<Summary, String> {
    let client = summary_client(fill, &c.name);
    let mut groups: BTreeMap<(String, String, String), Sums> = BTreeMap::new();
    let mut total = Sums::default();
    c.each(cfg, p, fill, |s| {
        let cl = s.client.clone().unwrap_or_else(|| client.clone());
        groups.entry((s.day.clone(), cl, s.branch.clone())).or_default().add(&s.row);
        total.add(&s.row);
        Ok(())
    })?;
    Ok(Summary { client, groups, total })
}

/// Header notes of a cluster's sheet: why it could not be collected, the fields that did not
/// resolve (once), incomplete days and days not collected.
fn cluster_notes(c: &ClusterHosts, p: &Period) -> Vec<String> {
    let mut notes = vec![];
    if let Some(f) = &c.failure {
        notes.push(format!("{}: not collected this time — {f}; the rows below are the days already held", c.name));
    }
    let mut unresolved: Vec<String> = vec![];
    let (mut incomplete, mut missing, mut failed) = (vec![], vec![], vec![]);
    for (day, end, cp) in day_flags(c, p) {
        match end {
            Some(e) => {
                if e.incomplete {
                    incomplete.push(format!("{day} ({} rows)", e.rows));
                }
                for n in e.notes {
                    if !unresolved.contains(&n) {
                        unresolved.push(n);
                    }
                }
            }
            None => match cp.and_then(|c| c.failed) {
                Some(why) => failed.push(format!("{day} ({why})")),
                None => missing.push(day),
            },
        }
    }
    if let Some(r) = c.dir.read(&p.days().iter().map(|d| day_key(*d)).find(|d| c.dir.held(d)).unwrap_or_default()) {
        for n in r.header.resolved.notes {
            if !unresolved.contains(&n) {
                unresolved.push(n);
            }
        }
    }
    notes.extend(unresolved);
    if !incomplete.is_empty() {
        notes.push(format!("incomplete (the page bound, UI_REPORT_HOSTS_MAX_PAGES, was reached): {}", incomplete.join(", ")));
    }
    if !failed.is_empty() {
        notes.push(format!("not collected, failed: {}", failed.join(", ")));
    }
    if !missing.is_empty() {
        notes.push(format!("not collected: {}", missing.join(", ")));
    }
    notes
}

pub const SUMMARY_HEAD: &[&str] = &["Cluster", "Client ID", "Branch", "Month", "Day", "Documents", "Event size (GB)", "Forwarded size (GB)"];
pub const SHEET_HEAD: &[&str] = &["Day", "Index", "Source", "Host", "Documents", "Event size (GB)", "Forwarded size (GB)"];

/// The workbook (docs/REPORT-TYPES.md "Workbook"), streamed: *Summary* first, then one sheet
/// per cluster continuing past the row limit. The day files are read three times — the
/// first ClientID, the Summary, the rows — and never held.
pub fn write_xlsx<W: Write>(book: &mut StreamBook<W>, clusters: &[ClusterHosts], cfg: &HostsConfig, p: &Period, failed: &[(String, String)]) -> Result<(), String> {
    let mut summary: Vec<Vec<Cell>> = vec![SUMMARY_HEAD.iter().map(|h| Cell::head(*h)).collect()];
    let mut fills = vec![];
    for c in clusters {
        let fill = c.fill(cfg, p);
        let s = summarize(c, cfg, p, &fill)?;
        for ((day, client, branch), sums) in &s.groups {
            summary.push(vec![
                Cell::text(&c.name), Cell::text(client), Cell::text(branch), Cell::text(day.get(..7).unwrap_or("")), Cell::text(day),
                Cell::Int(sums.docs as f64), gb_cell(sums.event_bytes), gb_cell(sums.sub_bytes),
            ]);
        }
        summary.push(vec![
            Cell::head(&c.name), Cell::head(&s.client), Cell::Empty, Cell::Empty, Cell::head("Actual total"),
            Cell::Int(s.total.docs as f64), gb_cell(s.total.event_bytes), gb_cell(s.total.sub_bytes),
        ]);
        fills.push(fill);
    }
    for (id, why) in failed {
        summary.push(vec![Cell::text(id), Cell::text(format!("not collected: {why}"))]);
    }
    book.sheet("Summary", &summary)?;
    drop(summary);
    for (c, fill) in clusters.iter().zip(&fills) {
        let mut head: Vec<Cell> = SHEET_HEAD.iter().map(|h| Cell::head(*h)).collect();
        head.extend(cfg.fields.iter().map(Cell::head));
        head.push(Cell::head("Note"));
        let mut widths = vec![11, 34, 18, 28, 12, 15, 18];
        widths.extend(cfg.fields.iter().map(|f| f.len().max(10) + 2));
        widths.push(12);
        book.begin_sheet(&c.name, head, widths)?;
        for n in cluster_notes(c, p) {
            book.row(&[Cell::text(n)])?;
        }
        let ci = cfg.fields.iter().position(|x| *x == cfg.client_id_field);
        let bi = cfg.fields.iter().position(|x| *x == cfg.branch_field);
        c.each(cfg, p, fill, |s| {
            let mut cells = vec![
                Cell::text(&s.day), Cell::text(&s.row.index), Cell::text(&s.source),
                Cell::text(s.row.host.as_deref().unwrap_or(NO_HOST)), Cell::Int(s.row.docs as f64),
                gb_cell(s.row.event_bytes), gb_cell(s.row.sub_bytes),
            ];
            for (i, m) in s.meta.iter().enumerate() {
                let v = if Some(i) == ci { s.client.clone() } else if Some(i) == bi { Some(s.branch.clone()) } else { m.clone() };
                cells.push(v.map(Cell::Text).unwrap_or(Cell::Empty));
            }
            cells.push(if s.incomplete { Cell::text("incomplete") } else { Cell::Empty });
            book.row(&cells)
        })?;
    }
    book.end_sheet()
}

fn csv_line(cells: &[String]) -> String {
    let mut s = cells.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(",");
    s.push('\n');
    s
}

fn opt(v: Option<u64>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

/// The CSV bundle, streamed: `summary.csv`, then one CSV per cluster. Sizes in bytes (an
/// empty cell is not measured).
pub fn write_csvzip<W: Write>(zip: &mut super::zip::StreamZip<W>, clusters: &[ClusterHosts], cfg: &HostsConfig, p: &Period, failed: &[(String, String)]) -> Result<(), String> {
    zip.begin("summary.csv")?;
    zip.write(csv_line(&["cluster", "client_id", "branch", "month", "day", "docs", "event_bytes", "sub_bytes", "note"].map(String::from)).as_bytes())?;
    let mut fills = vec![];
    for c in clusters {
        let fill = c.fill(cfg, p);
        let s = summarize(c, cfg, p, &fill)?;
        for ((day, client, branch), sums) in &s.groups {
            zip.write(csv_line(&[c.id.clone(), client.clone(), branch.clone(), day.get(..7).unwrap_or("").into(), day.clone(),
                                 sums.docs.to_string(), opt(sums.event_bytes), opt(sums.sub_bytes), String::new()]).as_bytes())?;
        }
        zip.write(csv_line(&[c.id.clone(), s.client.clone(), String::new(), String::new(), String::new(), s.total.docs.to_string(),
                             opt(s.total.event_bytes), opt(s.total.sub_bytes), "actual total".into()]).as_bytes())?;
        fills.push(fill);
    }
    for (id, why) in failed {
        zip.write(csv_line(&[id.clone(), String::new(), String::new(), String::new(), String::new(), String::new(), String::new(),
                             String::new(), format!("not collected: {why}")]).as_bytes())?;
    }
    let mut used = std::collections::HashSet::new();
    for (c, fill) in clusters.iter().zip(&fills) {
        let mut name = format!("{}.csv", super::build::file_part(&c.id));
        let mut k = 2;
        while !used.insert(name.clone()) {
            name = format!("{}-{k}.csv", super::build::file_part(&c.id));
            k += 1;
        }
        zip.begin(&name)?;
        let mut head: Vec<String> = ["day", "index", "source", "host", "docs", "event_bytes", "sub_bytes"].map(String::from).to_vec();
        head.extend(cfg.fields.iter().cloned());
        head.push("note".into());
        zip.write(csv_line(&head).as_bytes())?;
        for n in cluster_notes(c, p) {
            zip.write(csv_line(&[format!("# {n}")]).as_bytes())?;
        }
        let ci = cfg.fields.iter().position(|x| *x == cfg.client_id_field);
        let bi = cfg.fields.iter().position(|x| *x == cfg.branch_field);
        c.each(cfg, p, fill, |s| {
            let mut cells = vec![s.day.clone(), s.row.index.clone(), s.source.clone(), s.row.host.clone().unwrap_or_default(),
                                 s.row.docs.to_string(), opt(s.row.event_bytes), opt(s.row.sub_bytes)];
            for (i, m) in s.meta.iter().enumerate() {
                let v = if Some(i) == ci { s.client.clone() } else if Some(i) == bi { Some(s.branch.clone()) } else { m.clone() };
                cells.push(v.unwrap_or_default());
            }
            cells.push(if s.incomplete { "incomplete".into() } else { String::new() });
            zip.write(csv_line(&cells).as_bytes())
        })?;
    }
    zip.end()
}

/// The mail's text: per cluster its total over the period (the Summary's *Actual total*),
/// and every cluster that could not be collected.
pub fn mail_text(clusters: &[ClusterHosts], cfg: &HostsConfig, p: &Period, failed: &[(String, String)]) -> String {
    let mut out = String::new();
    for c in clusters {
        let fill = c.fill(cfg, p);
        match summarize(c, cfg, p, &fill) {
            Ok(s) => {
                let gb = |v: Option<u64>| v.map(|b| format!("{:.2} GB", b as f64 / GB)).unwrap_or_else(|| NOT_MEASURED.into());
                out.push_str(&format!("{} (client {})\n  Documents: {}\n  Event size: {}\n  Forwarded size: {}\n",
                                      c.name, s.client, s.total.docs, gb(s.total.event_bytes), gb(s.total.sub_bytes)));
            }
            Err(e) => out.push_str(&format!("{}: {e}\n", c.name)),
        }
        for n in cluster_notes(c, p) {
            out.push_str(&format!("  Note: {n}\n"));
        }
    }
    for (id, why) in failed {
        out.push_str(&format!("{id}: not collected — {why}\n"));
    }
    out
}

/* ------------------------------------------ the view ------------------------------------------ */

/// A `HOSTS_QUERY` sort: one of the sheet's columns, ascending or (`-` first) descending.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortKey {
    Day,
    Index,
    Source,
    Host,
    Docs,
    EventBytes,
    SubBytes,
    ClientId,
    Branch,
}

pub fn parse_sort(s: &str) -> Option<(SortKey, bool)> {
    let (desc, k) = match s.strip_prefix('-') {
        Some(k) => (true, k),
        None => (false, s),
    };
    let key = match k {
        "day" => SortKey::Day,
        "index" => SortKey::Index,
        "source" => SortKey::Source,
        "host" => SortKey::Host,
        "docs" => SortKey::Docs,
        "eventBytes" => SortKey::EventBytes,
        "subBytes" => SortKey::SubBytes,
        "clientId" => SortKey::ClientId,
        "branch" => SortKey::Branch,
        _ => return None,
    };
    Some((key, desc))
}

fn cmp_shown(a: &Shown, b: &Shown, key: SortKey) -> std::cmp::Ordering {
    let o = match key {
        SortKey::Day => a.day.cmp(&b.day),
        SortKey::Index => a.row.index.cmp(&b.row.index),
        SortKey::Source => a.source.cmp(&b.source),
        SortKey::Host => a.row.host.cmp(&b.row.host),
        SortKey::Docs => a.row.docs.cmp(&b.row.docs),
        SortKey::EventBytes => a.row.event_bytes.cmp(&b.row.event_bytes),
        SortKey::SubBytes => a.row.sub_bytes.cmp(&b.row.sub_bytes),
        SortKey::ClientId => a.client.cmp(&b.client),
        SortKey::Branch => a.branch.cmp(&b.branch),
    };
    // File order breaks a tie, so pages never overlap.
    o.then_with(|| a.day.cmp(&b.day)).then_with(|| a.row.index.cmp(&b.row.index)).then_with(|| a.row.host.cmp(&b.row.host))
}

/// `HOSTS_QUERY`'s answer, read from the day files a row at a time. Unsorted (file order:
/// day, index, host) it keeps only the page asked for; sorted it keeps the best
/// `offset + limit` rows seen so far, never the period (`QUERY_DEPTH_MAX` deep at most).
pub fn query(c: &ClusterHosts, cfg: &HostsConfig, p: &Period, q: &str, sort: Option<(SortKey, bool)>, offset: usize, limit: usize) -> Result<Value, String> {
    let fill = c.fill(cfg, p);
    let needle = q.trim().to_lowercase();
    let hit = |s: &Shown| needle.is_empty()
        || s.row.index.to_lowercase().contains(&needle)
        || s.row.host.as_deref().unwrap_or("").to_lowercase().contains(&needle)
        || s.client.as_deref().unwrap_or("").to_lowercase().contains(&needle);
    let keep = offset + limit;
    let mut total = 0usize;
    let mut sums = Sums::default();
    let mut kept: Vec<Shown> = vec![];
    let order = |a: &Shown, b: &Shown| match sort {
        Some((k, desc)) => {
            let o = cmp_shown(a, b, k);
            if desc { o.reverse() } else { o }
        }
        None => std::cmp::Ordering::Equal,
    };
    c.each(cfg, p, &fill, |s| {
        if !hit(&s) {
            return Ok(());
        }
        total += 1;
        sums.add(&s.row);
        match sort {
            None => {
                if total > offset && kept.len() < limit {
                    kept.push(s);
                }
            }
            Some(_) => {
                kept.push(s);
                if kept.len() >= keep.max(1) * 2 {
                    kept.sort_by(order);
                    kept.truncate(keep);
                }
            }
        }
        Ok(())
    })?;
    if sort.is_some() {
        kept.sort_by(order);
        kept = kept.into_iter().skip(offset).take(limit).collect();
    }
    let rows: Vec<Value> = kept.iter().map(|s| {
        let meta: Map<String, Value> = cfg.fields.iter().zip(&s.meta).map(|(f, v)| (f.clone(), json!(v))).collect();
        json!({ "day": s.day, "index": s.row.index, "source": s.source, "host": s.row.host, "docs": s.row.docs,
                "eventBytes": s.row.event_bytes, "subBytes": s.row.sub_bytes, "eventMissingDocs": s.row.event_missing,
                "clientId": s.client, "branch": s.branch, "meta": meta, "incomplete": s.incomplete })
    }).collect();
    let days: Vec<Value> = day_flags(c, p).into_iter().map(|(day, end, cp)| match end {
        Some(e) => json!({ "day": day, "held": true, "incomplete": e.incomplete, "rows": e.rows, "notes": e.notes, "failed": null }),
        None => json!({ "day": day, "held": false, "incomplete": false, "rows": null, "notes": [],
                        "failed": cp.as_ref().and_then(|c| c.failed.clone()), "collecting": cp.is_some_and(|c| c.failed.is_none()) }),
    }).collect();
    Ok(json!({
        "ok": true, "clusterId": c.id, "period": p, "fields": cfg.fields, "fill": { "clientId": fill.first_client, "branchDefault": fill.branch_default },
        "rows": rows, "total": total, "offset": offset, "limit": limit,
        "totals": { "docs": sums.docs, "eventBytes": sums.event_bytes, "subBytes": sums.sub_bytes },
        "days": days,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("ep-hosts-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn resolved() -> Resolved {
        Resolved { source_host: Some("src_hostname".into()), event_size: Some("event_logsize".into()), sub_size: None,
                   meta: vec![Some("ClientID".into()), None, Some("branch".into())], notes: vec![] }
    }

    fn row(index: &str, host: Option<&str>, docs: u64, client: Option<&str>, branch: Option<&str>) -> HostRow {
        HostRow { index: index.into(), host: host.map(String::from), docs, event_bytes: Some(docs * 10), sub_bytes: None,
                  event_missing: 0, meta: vec![client.map(String::from), None, branch.map(String::from)] }
    }

    #[test]
    fn the_composite_body_pages_by_after_key_with_a_missing_host_bucket() {
        let q = json!({ "terms": { "_index": ["logstash-a-2026.11.01"] } });
        let b = composite_body(&q, &resolved(), 1000, None);
        assert_eq!(b["query"], q, "the Daily record's day");
        let c = &b["aggs"]["h"]["composite"];
        assert_eq!(c["size"], 1000);
        assert_eq!(c["sources"][1]["h"]["terms"], json!({ "field": "src_hostname", "missing_bucket": true }));
        assert!(c.get("after").is_none());
        let aggs = &b["aggs"]["h"]["aggs"];
        assert_eq!(aggs["ev"]["sum"]["field"], "event_logsize");
        assert_eq!(aggs["m_ev"]["missing"]["field"], "event_logsize");
        assert!(aggs.get("sub").is_none(), "an unresolved size is not asked");
        assert_eq!(aggs["md0"]["terms"], json!({ "field": "ClientID", "size": 1 }));
        assert!(aggs.get("md1").is_none() && aggs.get("md2").is_some());
        let after = json!({ "i": "logstash-a-2026.11.01", "h": "web1" });
        assert_eq!(composite_body(&q, &resolved(), 500, Some(&after))["aggs"]["h"]["composite"]["after"], after);

        let page = json!({ "aggregations": { "h": { "after_key": after, "buckets": [
            { "key": { "i": "logstash-a-2026.11.01", "h": "web1" }, "doc_count": 3, "ev": { "value": 30.0 }, "m_ev": { "doc_count": 1 },
              "md0": { "buckets": [ { "key": "C42", "doc_count": 3 } ] }, "md2": { "buckets": [] } },
            { "key": { "i": "logstash-a-2026.11.01", "h": null }, "doc_count": 2, "ev": { "value": 0.0 }, "m_ev": { "doc_count": 2 } },
        ] } } });
        let p = read_page(&page, &resolved(), 2).unwrap();
        assert!(!p.done, "a full page with an after_key: more to come");
        assert_eq!(p.after, Some(after.clone()));
        assert_eq!(p.rows[0], HostRow { index: "logstash-a-2026.11.01".into(), host: Some("web1".into()), docs: 3, event_bytes: Some(30),
                                        sub_bytes: None, event_missing: 1, meta: vec![Some("C42".into()), None, None] });
        assert_eq!(p.rows[1].host, None, "the missing bucket is a row of its own");
        assert!(read_page(&page, &resolved(), 1000).unwrap().done, "fewer buckets than asked: the last page");
        assert!(read_page(&json!({ "aggregations": { "h": { "buckets": [] } } }), &resolved(), 1000).unwrap().done);
        assert!(read_page(&json!({ "_shards": { "total": 2, "failed": 1 }, "aggregations": { "h": { "buckets": [] } } }), &resolved(), 10).is_err(),
                "a partial answer is asked again, not taken for the end");
    }

    #[test]
    fn a_page_too_large_for_the_share_halves_the_next_down_to_the_floor() {
        assert_eq!(next_page_size(1000, 10, 100), 1000);
        assert_eq!(next_page_size(1000, 101, 100), 500);
        assert_eq!(next_page_size(500, 101, 100), 250);
        assert_eq!(next_page_size(250, 101, 100), 125);
        assert_eq!(next_page_size(125, 101, 100), PAGE_SIZE_MIN);
        assert_eq!(next_page_size(PAGE_SIZE_MIN, 101, 100), PAGE_SIZE_MIN);
    }

    fn header(day: &str) -> DayHeader {
        DayHeader { v: 1, day: day.into(), fields: vec!["ClientID".into(), "zone".into(), "branch".into()], resolved: resolved(), started_at: 1 }
    }

    #[test]
    fn each_partition_resumes_from_its_checkpoint_and_the_day_is_renamed_into_place_only_at_the_end() {
        let root = tmp();
        let d = HostsDir::new(&root, "prod/x");
        let parts = vec![vec!["i1".to_string(), "i2".into()], vec!["i3".to_string()]];
        let mut cp = d.begin(header("2026-11-01"), parts, 1000, 1).unwrap();
        d.append(&mut cp, 0, &[row("i1", Some("a"), 1, None, None)], Some(json!({ "i": "i1", "h": "a" })), false, 2).unwrap();
        d.append(&mut cp, 1, &[row("i3", Some("c"), 3, None, None)], Some(json!({ "i": "i3", "h": "c" })), false, 2).unwrap();
        assert!(!d.held("2026-11-01"), "not before the last page");
        assert!(d.part_path("2026-11-01", 0).is_file() && d.part_path("2026-11-01", 1).is_file());
        // A page written to partition 1 but its checkpoint never: the process died between.
        let kept = d.checkpoint("2026-11-01").unwrap();
        let mut ghost = kept.clone();
        d.append(&mut ghost, 1, &[row("i3", Some("zz"), 99, None, None)], None, true, 3).unwrap();
        d.save_checkpoint(&kept).unwrap();
        // Resume: each partition cut back to its own checkpoint and continued after its own
        // after_key.
        let mut cp = d.checkpoint("2026-11-01").unwrap();
        assert_eq!((cp.rows(), cp.pages(), cp.parts_done()), (2, 2, 0));
        assert_eq!(cp.parts[1].after, Some(json!({ "i": "i3", "h": "c" })));
        d.resume(&cp).unwrap();
        d.append(&mut cp, 1, &[row("i3", Some("d"), 4, None, None)], None, true, 4).unwrap();
        d.append(&mut cp, 0, &[row("i2", None, 2, Some("C1"), None)], None, true, 4).unwrap();
        assert!(cp.finished());
        d.complete(&cp, &DayEnd { rows: cp.rows(), pages: cp.pages(), incomplete: false, notes: vec![], collected_at: 5 }).unwrap();
        assert!(d.held("2026-11-01") && !d.part_path("2026-11-01", 0).exists() && d.checkpoint("2026-11-01").is_none());
        let r = d.read("2026-11-01").unwrap();
        assert_eq!(r.header.day, "2026-11-01");
        let rows: Vec<HostRow> = d.read("2026-11-01").unwrap().collect();
        assert_eq!(rows.iter().map(|r| (r.index.as_str(), r.docs)).collect::<Vec<_>>(), [("i1", 1), ("i2", 2), ("i3", 3), ("i3", 4)],
                   "partitions in order, so index order; the ghost page is gone");
        assert_eq!(r.finish().unwrap().rows, 4);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.final_path("2026-11-01")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Collect again: the held day stays until the new one replaces it.
        let mut again = d.begin(header("2026-11-01"), vec![vec!["i3".into()]], 1000, 6).unwrap();
        assert!(d.held("2026-11-01"));
        d.append(&mut again, 0, &[row("i3", Some("b"), 3, None, None)], None, true, 7).unwrap();
        d.complete(&again, &DayEnd { rows: 1, pages: 1, incomplete: false, notes: vec![], collected_at: 8 }).unwrap();
        assert_eq!(d.read("2026-11-01").unwrap().map(|r| r.index).collect::<Vec<_>>(), ["i3"]);
        // A day with nothing to ask is a file at once.
        d.write_empty(header("2026-11-03"), vec!["no index".into()], 9).unwrap();
        assert_eq!(d.read("2026-11-03").unwrap().finish().unwrap().notes, ["no index"]);
        // A .part shorter than its checkpoint is not resumed.
        let mut cp = d.begin(header("2026-11-02"), vec![vec!["x".into()]], 1000, 9).unwrap();
        d.append(&mut cp, 0, &[row("x", None, 1, None, None)], None, false, 9).unwrap();
        std::fs::write(d.part_path("2026-11-02", 0), b"x").unwrap();
        assert!(d.resume(&cp).is_err());
        // Pruned with everything of the day.
        assert_eq!(d.prune(parse_day("2026-11-02").unwrap()), 1);
        assert!(!d.held("2026-11-01") && d.checkpoint("2026-11-02").is_some());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_failed_day_is_taken_up_three_ticks_then_waits() {
        let mut cp = Checkpoint::default();
        assert!(cp.resumable(0, 900_000), "interrupted: at once");
        cp.failed = Some("timeout".into());
        cp.failed_at = Some(1_000);
        cp.failed_ticks = 1;
        assert!(!cp.resumable(1_500, 900_000), "not before the wait");
        assert!(cp.resumable(901_000, 900_000));
        cp.failed_ticks = MAX_FAILED_TICKS;
        assert!(!cp.resumable(10_000_000, 900_000), "three failed ticks: a person's turn");
    }

    #[test]
    fn client_id_and_branch_are_filled_as_the_script_did() {
        for m in [None, Some(""), Some("__missing__"), Some("None"), Some("nan"), Some(" NaN ")] {
            assert!(is_missing(m), "{m:?}");
        }
        assert!(!is_missing(Some("C1")) && !is_missing(Some("0")));
        let fill = Fill { first_client: Some("C42".into()), branch_default: "DC".into() };
        assert_eq!(fill_client_branch(None, None, &fill), (Some("C42".into()), "DC".into()));
        assert_eq!(fill_client_branch(Some("nan"), Some("__missing__"), &fill), (Some("C42".into()), "DC".into()));
        assert_eq!(fill_client_branch(Some("C7"), Some("BLR"), &fill), (Some("C7".into()), "BLR".into()), "a value of its own stays");
        let none = Fill { first_client: None, branch_default: "DC".into() };
        assert_eq!(fill_client_branch(None, None, &none).0, None);
        assert_eq!(summary_client(&none, "Production"), "Production", "no ClientID anywhere: the cluster's name");
        assert_eq!(summary_client(&fill, "Production"), "C42");

        // The first valid ClientID in day, then index order.
        let root = tmp();
        let dir = HostsDir::new(&root, "c");
        for (day, rows) in [
            ("2026-11-01", vec![row("a-2026.11.01", Some("h"), 1, Some("None"), None)]),
            ("2026-11-02", vec![row("a-2026.11.02", Some("h"), 1, Some("__missing__"), None), row("b-2026.11.02", Some("h"), 1, Some("C9"), Some("BLR"))]),
            ("2026-11-03", vec![row("a-2026.11.03", Some("h"), 1, Some("C1"), None)]),
        ] {
            let mut cp = dir.begin(header(day), vec![vec!["all".into()]], 1000, 1).unwrap();
            dir.append(&mut cp, 0, &rows, None, true, 2).unwrap();
            dir.complete(&cp, &DayEnd { rows: rows.len() as u64, pages: 1, incomplete: day == "2026-11-03", notes: vec![], collected_at: 3 }).unwrap();
        }
        let cfg = HostsConfig { fields: vec!["ClientID".into(), "zone".into(), "branch".into()], ..HostsConfig::default() };
        let c = ClusterHosts { id: "c".into(), name: "Cluster C".into(), dir, ind: None, failure: None };
        let p: Period = serde_json::from_value(json!({ "from": "2026-11-01", "to": "2026-11-04", "label": "x" })).unwrap();
        let fill = c.fill(&cfg, &p);
        assert_eq!(fill.first_client.as_deref(), Some("C9"), "C1 comes a day later");
        let mut shown = vec![];
        c.each(&cfg, &p, &fill, |s| { shown.push(s); Ok(()) }).unwrap();
        assert_eq!(shown.iter().map(|s| (s.client.clone().unwrap(), s.branch.clone())).collect::<Vec<_>>(),
                   [("C9".into(), "DC".into()), ("C9".into(), "DC".into()), ("C9".into(), "BLR".into()), ("C1".into(), "DC".into())]);
        assert!(shown[3].incomplete && !shown[0].incomplete);
        assert_eq!(shown[0].row.meta[0].as_deref(), Some("None"), "the stored row keeps what Elasticsearch said");
        let s = summarize(&c, &cfg, &p, &fill).unwrap();
        assert_eq!((s.client.as_str(), s.total.docs, s.total.event_bytes, s.total.sub_bytes), ("C9", 4, Some(40), None));
        assert_eq!(s.groups.len(), 4);

        // The view: search, sort, page, totals and the day flags.
        let v = query(&c, &cfg, &p, "b-2026", None, 0, 200).unwrap();
        assert_eq!((v["total"].as_u64(), v["rows"][0]["clientId"].as_str()), (Some(1), Some("C9")));
        let v = query(&c, &cfg, &p, "", Some((SortKey::Day, true)), 1, 2).unwrap();
        assert_eq!(v["total"], 4);
        assert_eq!(v["rows"].as_array().unwrap().iter().map(|r| r["index"].as_str().unwrap()).collect::<Vec<_>>(), ["b-2026.11.02", "a-2026.11.02"]);
        assert_eq!(v["totals"]["docs"], 4);
        assert_eq!(v["days"][2]["incomplete"], true);
        assert_eq!(v["days"][3]["held"], false);
        assert_eq!(v["rows"][0]["meta"]["branch"], "BLR");

        // The workbook: Summary first, the cluster's sheet with its notes, rows and fill.
        let mut book = StreamBook::new(Vec::new());
        write_xlsx(&mut book, &[c], &cfg, &p, &[("lost".into(), "timed out".into())]).unwrap();
        let bytes = book.finish().unwrap();
        let parts = super::super::zip::read(&bytes).unwrap();
        let text = |n: &str| String::from_utf8(parts.iter().find(|(x, _)| x == n).unwrap().1.clone()).unwrap();
        let summary = text("xl/worksheets/sheet1.xml");
        assert!(summary.contains("Actual total") && summary.contains("C9") && summary.contains("not collected: timed out"), "{summary}");
        let sheet = text("xl/worksheets/sheet2.xml");
        assert!(sheet.contains("incomplete") && sheet.contains("not collected: 2026-11-04") && sheet.contains("BLR"), "{sheet}");
        assert!(text("xl/workbook.xml").contains(r#"name="Cluster C""#));
        std::fs::remove_dir_all(root).ok();
    }
}
