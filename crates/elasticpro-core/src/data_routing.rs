//! Backend routing (docs/HISTORY.md "Backend routing"): where ElasticPro keeps what it records.
//!
//! Three kinds of data — **history** (the volume, capacity and log-delay records), **reports**
//! (the generated files and their job history) and **alerts** (acknowledged, silenced, and what
//! the pages saw raised and cleared) — each kept in one of:
//!
//! | mode | meaning |
//! |---|---|
//! | `builtin` | the server's data directory, as before this feature; nothing of this kind goes to the store |
//! | `copy` | the built-in store **and** the history store: queued for the store only while its two gates are open (a closed gate is not a backlog — the history store's rule since 0.3.53) |
//! | `es` | the history store is where it is kept for good. While the store is not connected and writing (a gate closed, the test failed, the store unreachable) the record goes in the queue anyway — bounded, on disk, oldest first out and counted — and the built-in store keeps writing, so nothing is lost; when the store is back, the queue is sent |
//!
//! The Elasticsearch side is **always the dedicated history store** (`history_store.rs`: its own
//! address and credential, never a monitored cluster, its own guard, its two gates). This module
//! adds no destination, no gate and no privilege: it decides *whether* a record is offered to
//! that store, builds the report and alert documents and their index templates, and reads the
//! sizes the Data › Backend page shows. The built-in store's retention is unchanged in every
//! mode: this feature deletes nothing, on the server or on the store (the store's retention is
//! its owner's ILM; the templates hold mappings only).
//!
//! **Unknown is not zero.** A size the core cannot walk, a document count the store did not
//! answer, a figure a report did not measure: `null`, with the reason beside it.
//!
//! **One definition.** `admits` decides, for every kind alike, whether a record is queued now;
//! `status_line` says, for every kind alike, whether it is writing and why not.

use crate::history_store::{QKey, Queued};
use crate::report::jobs::Job;
use crate::volume::schedule::{day_key, utc_day};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = "data-routing.json";
/// Where another process (the report worker, docs/WORKER.md) leaves records for the core's
/// writer to queue: one JSON file per record, drained by the history store's tick.
pub const SPOOL_DIR: &str = "history-store-spool";
pub const REPORTS_STREAM: &str = "reports";
pub const ALERTS_STREAM: &str = "alerts";
/// The streams that are "history" to the routing: the ones the history store wrote before.
pub const HISTORY_STREAMS: [&str; 3] = ["volume", "capacity", "delay"];
/// A report file is carried inside its record only up to this size (the bulk is capped at 4 MiB).
pub const REPORT_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Spool files one tick drains at most.
pub const SPOOL_PER_TICK: usize = 1000;
/// A page's `raised` or `cleared` for the same alert within this window is the same event.
pub const ALERT_EVENT_DEDUPE_MS: u64 = 15 * 60_000;
/// Events one `ALERT_EVENTS_PUT` may carry.
pub const ALERT_EVENTS_MAX: usize = 200;
/// The directory walk for "size now" stops here (the figure is then a floor, and says so).
pub const SIZE_WALK_CAP: usize = 200_000;
/// A document count read from the store is kept this long before it is asked again.
pub const COUNT_FOR_MS: u64 = 60_000;
/// What the store keeps its documents for: its owner's business, never ElasticPro's.
pub const STORE_KEPT_FOR: &str = "the store owner's ILM";

/* -------------------------------------------- kinds and modes -------------------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    History,
    Reports,
    Alerts,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::History, Kind::Reports, Kind::Alerts];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::History => "history",
            Kind::Reports => "reports",
            Kind::Alerts => "alerts",
        }
    }

    /// The kind a queue stream belongs to; `None` for a stream nobody routes.
    pub fn of_stream(stream: &str) -> Option<Kind> {
        match stream {
            s if HISTORY_STREAMS.contains(&s) => Some(Kind::History),
            REPORTS_STREAM => Some(Kind::Reports),
            ALERTS_STREAM => Some(Kind::Alerts),
            _ => None,
        }
    }

    /// The store's index patterns this kind writes into, under `prefix`.
    pub fn patterns(self, prefix: &str) -> Vec<String> {
        match self {
            Kind::History => HISTORY_STREAMS.iter().map(|s| format!("{prefix}-{s}-*")).collect(),
            Kind::Reports => vec![format!("{prefix}-{REPORTS_STREAM}-*")],
            Kind::Alerts => vec![format!("{prefix}-{ALERTS_STREAM}-*")],
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Builtin,
    Copy,
    Es,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "builtin" => Some(Mode::Builtin),
            "copy" => Some(Mode::Copy),
            "es" => Some(Mode::Es),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Builtin => "builtin",
            Mode::Copy => "copy",
            Mode::Es => "es",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mode::Builtin => "ElasticPro built-in",
            Mode::Copy => "ElasticPro + Elasticsearch (copy)",
            Mode::Es => "Elasticsearch only",
        }
    }

    /// Anything of this kind is ever offered to the store.
    pub fn sends_to_store(self) -> bool {
        self != Mode::Builtin
    }
}

/// Whether a record of a kind in `mode` is queued for the store now, given whether the
/// store's gates are open. The one definition for every kind: `copy` queues only while the
/// store can be written (a closed gate is not a backlog); `es` queues regardless, because the
/// store is where the record is kept for good and the queue is how it gets there later.
pub fn admits(mode: Mode, gates_open: bool) -> bool {
    match mode {
        Mode::Builtin => false,
        Mode::Copy => gates_open,
        Mode::Es => true,
    }
}

/// What `data-routing.json` holds.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routing {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub history: Mode,
    #[serde(default)]
    pub reports: Mode,
    #[serde(default)]
    pub alerts: Mode,
    /// Carry the report file itself inside its record (up to `REPORT_FILE_MAX_BYTES`).
    #[serde(default)]
    pub report_files: bool,
    #[serde(default)]
    pub changed_by: Option<String>,
    #[serde(default)]
    pub changed_at: Option<u64>,
}

impl Routing {
    pub fn mode(&self, k: Kind) -> Mode {
        match k {
            Kind::History => self.history,
            Kind::Reports => self.reports,
            Kind::Alerts => self.alerts,
        }
    }

    pub fn public(&self) -> Value {
        json!({
            "history": self.history, "reports": self.reports, "alerts": self.alerts,
            "reportFiles": self.report_files, "changedBy": self.changed_by, "changedAt": self.changed_at,
        })
    }
}

/// What `DATA_ROUTING_SET {routing: {...}}` carries, checked against what is held: a field left
/// out keeps its value, a mode that is not one is refused by name.
pub fn parse_incoming(v: &Value, current: &Routing) -> Result<Routing, String> {
    let o = v.as_object().ok_or("routing: an object with history, reports, alerts and reportFiles")?;
    let mut next = current.clone();
    for (k, slot) in [("history", &mut next.history), ("reports", &mut next.reports), ("alerts", &mut next.alerts)] {
        if let Some(m) = o.get(k) {
            let s = m.as_str().ok_or_else(|| format!("{k}: builtin, copy or es"))?;
            *slot = Mode::parse(s).ok_or_else(|| format!("{k}: {s:?} is not builtin, copy or es"))?;
        }
    }
    if let Some(f) = o.get("reportFiles") {
        next.report_files = f.as_bool().ok_or("reportFiles: true or false")?;
    }
    for k in o.keys() {
        if !matches!(k.as_str(), "history" | "reports" | "alerts" | "reportFiles") {
            return Err(format!("{k}: not a routing field"));
        }
    }
    Ok(next)
}

/* ---------------------------------------------- the file ---------------------------------------------- */

pub struct DataRouting {
    path: Option<PathBuf>,
    spool: Option<PathBuf>,
    /// This process decides the routing (role `core` or `all`); the worker reads the file.
    writer: bool,
    stored: RwLock<Routing>,
    /// An admin has saved a routing (the file exists). Until then history follows the store:
    /// a copy while *Write history* is armed — what arming meant before this feature — else
    /// built-in; the other kinds are built-in.
    saved: std::sync::atomic::AtomicBool,
    /// `(event, key)` → when a page last reported it: a second report inside the window is the same event.
    recent_alerts: Mutex<BTreeMap<(String, String), u64>>,
    /// Document counts read from the store, per pattern: `(at, count)`; `None` = not answered.
    counts: Mutex<BTreeMap<String, (u64, Option<u64>)>>,
}

impl DataRouting {
    /// Hosted keeps the routing in the data directory; every other edition has none. A file
    /// that is not there yet means built-in for everything, with history following the store
    /// (`current`): a store an admin armed before this feature existed was a copy, and stays one.
    pub fn open(data_dir: Option<&Path>, hosted: bool, writer: bool) -> DataRouting {
        let dir = data_dir.filter(|_| hosted);
        let path = dir.map(|d| d.join(FILE));
        let spool = dir.map(|d| d.join(SPOOL_DIR));
        let on_disk: Option<Routing> = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok());
        let saved = std::sync::atomic::AtomicBool::new(on_disk.is_some());
        DataRouting { path, spool, writer, stored: RwLock::new(on_disk.unwrap_or_default()), saved,
                      recent_alerts: Mutex::new(BTreeMap::new()), counts: Mutex::new(BTreeMap::new()) }
    }

    pub fn supported(&self) -> bool {
        self.path.is_some()
    }

    /// The routing in force: this process's own when it decides it, else the file as it is
    /// now (the worker, so a change by the core is seen at the next job). Until an admin has
    /// saved one, history is a copy while the store is armed (`history_armed`) — nothing an
    /// admin set up before this feature stops — and built-in otherwise.
    pub fn current(&self, history_armed: bool) -> Routing {
        let on_disk = (!self.writer).then_some(self.path.as_ref()).flatten()
            .and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Routing>(&b).ok());
        let saved = on_disk.is_some() || self.saved.load(std::sync::atomic::Ordering::SeqCst);
        let mut r = on_disk.unwrap_or_else(|| self.stored.read().clone());
        if !saved && history_armed {
            r.history = Mode::Copy;
        }
        r
    }

    /// Change the routing and write it; kept only when the file was written.
    pub fn set(&self, mut next: Routing, by: &str, now_ms: u64) -> Result<Routing, String> {
        if !self.writer {
            return Err("the routing is the core's to change".into());
        }
        let mut g = self.stored.write();
        next.version = 1;
        next.changed_by = Some(by.to_string());
        next.changed_at = Some(now_ms);
        if let Some(p) = &self.path {
            let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
            crate::volume::store::write_atomic(p, &bytes)?;
        }
        *g = next.clone();
        self.saved.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(next)
    }

    pub fn spool_dir(&self) -> Option<&Path> {
        self.spool.as_deref()
    }

    /// Leave a record for the writer's tick to queue (`Spooled`), one file, written whole.
    pub fn spool(&self, s: &Spooled) -> Result<(), String> {
        let dir = self.spool.as_ref().ok_or("no data directory")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let safe: String = s.id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(80).collect();
        let name = format!("{}-{safe}-{}.json", s.stream, s.at);
        let bytes = serde_json::to_vec(s).map_err(|e| e.to_string())?;
        crate::volume::store::write_atomic(&dir.join(name), &bytes)
    }

    /// The spool's files, oldest first, at most `SPOOL_PER_TICK`: each parsed with its path, so
    /// the caller removes what it took (parsed or not — a file that is not a record is noise).
    pub fn spooled(&self) -> Vec<(PathBuf, Option<Spooled>)> {
        let Some(dir) = &self.spool else { return vec![] };
        let mut names: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten()
            .map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        names.sort();
        names.into_iter().take(SPOOL_PER_TICK)
            .map(|p| { let s = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()); (p, s) }).collect()
    }

    /// Whether a page's `raised`/`cleared` for `key` is new, and remember it. Pure but for the clock.
    pub fn alert_event_is_new(&self, event: &str, key: &str, now_ms: u64) -> bool {
        let mut m = self.recent_alerts.lock();
        m.retain(|_, at| now_ms.saturating_sub(*at) < ALERT_EVENT_DEDUPE_MS);
        if m.len() > 50_000 {
            m.clear();
        }
        match m.get(&(event.to_string(), key.to_string())) {
            Some(_) => false,
            None => {
                m.insert((event.to_string(), key.to_string()), now_ms);
                true
            }
        }
    }

    /// A count read from the store, if read within `COUNT_FOR_MS`: `Some(answer)`.
    pub fn count_cached(&self, pattern: &str, now_ms: u64) -> Option<Option<u64>> {
        self.counts.lock().get(pattern).filter(|(at, _)| now_ms.saturating_sub(*at) < COUNT_FOR_MS).map(|(_, n)| *n)
    }

    pub fn count_note(&self, pattern: &str, now_ms: u64, n: Option<u64>) {
        self.counts.lock().insert(pattern.to_string(), (now_ms, n));
    }
}

/// One record on its way to the writer's queue, as the spool holds it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Spooled {
    pub stream: String,
    pub cluster: String,
    pub id: String,
    pub day: String,
    pub at: u64,
    pub doc: Value,
}

impl Spooled {
    pub fn into_queued(self) -> (QKey, Queued) {
        ((self.stream, self.cluster, self.id), Queued { day: self.day, doc: self.doc, tries: 0 })
    }
}

/* ------------------------------------------------ status ------------------------------------------------ */

/// One line per kind, the same rule for all three: `(state, line)` where `state` is
/// `writing` (records reach the store), `queued` (es: the store cannot be written now, the
/// record is in the built-in store and `queued` wait), `paused` (copy: the store cannot be
/// written now, nothing is queued for later) or `builtin` (nothing of this kind goes to the store).
pub fn status_line(mode: Mode, not_writing: Option<&str>, queued: usize) -> (&'static str, String) {
    match (mode, not_writing) {
        (Mode::Builtin, _) => ("builtin", "ElasticPro built-in only".into()),
        (_, None) if queued > 0 => ("writing", format!("writing · {queued} queued")),
        (_, None) => ("writing", "writing".into()),
        (Mode::Es, Some(why)) => ("queued", format!("not writing to Elasticsearch: {why} · kept in the built-in store meanwhile · {queued} queued")),
        (Mode::Copy, Some(why)) => ("paused", format!("not copying to Elasticsearch: {why} · kept in the built-in store")),
    }
}

/// Bytes a kind takes in the data directory, with how the figure was read.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinSize {
    /// `None`: there is no such place yet, or it could not be read — never 0 for "unknown".
    pub bytes: Option<u64>,
    pub files: Option<u64>,
    /// The walk stopped at `SIZE_WALK_CAP` entries: the figure is a floor.
    pub truncated: bool,
}

/// The size of what is under `paths` (files and directories; a path that is not there counts
/// nothing, and when none is there the size is unknown, not 0).
pub fn builtin_size(paths: &[PathBuf]) -> BuiltinSize {
    let mut out = BuiltinSize::default();
    for p in paths {
        let Ok(m) = std::fs::metadata(p) else { continue };
        let (b, f, t) = if m.is_dir() { crate::health::dir_size(p, SIZE_WALK_CAP) } else { (m.len(), 1, false) };
        out.bytes = Some(out.bytes.unwrap_or(0) + b);
        out.files = Some(out.files.unwrap_or(0) + f);
        out.truncated |= t;
    }
    out
}

/* ----------------------------------------------- documents ----------------------------------------------- */

/// `<prefix>-<stream>-YYYY` for a `YYYY-MM-DD` day: reports and alerts are yearly indices.
pub fn year_index(prefix: &str, stream: &str, day: &str) -> Option<String> {
    let d = crate::volume::schedule::parse_day(day)?;
    Some(format!("{prefix}-{stream}-{}", d.format("%Y")))
}

fn ms_day(ms: i64) -> String {
    day_key(utc_day(ms))
}

/// A report file carried inside its record.
pub struct FileCarried<'a> {
    pub name: &'a str,
    pub base64: String,
}

/// One report job as its record on the store: what it was, what it made, what it measured.
/// `figures` are the job's own counts, `null` where the job did not count (a volume report
/// counts days, not rows).
pub fn report_doc(j: &Job, file: Option<FileCarried<'_>>, now_ms: u64) -> Value {
    let ended = j.ended_at.unwrap_or(now_ms as i64);
    let rows: Option<u64> = (!j.progress.clusters.is_empty()).then(|| j.progress.clusters.values().map(|c| c.rows).sum());
    let clusters_done = (!j.progress.clusters.is_empty()).then(|| j.progress.clusters.values().filter(|c| c.state == "done").count() as u64);
    let mut doc = json!({
        "jobId": j.id, "kind": j.kind, "report": j.report, "status": j.status,
        "clusterIds": j.cluster_ids, "clusterName": j.cluster_name,
        "period": { "from": j.period.from, "to": j.period.to, "label": j.period.label },
        "format": j.format, "mail": j.mail, "by": j.by,
        "createdAt": j.created_at, "startedAt": j.started_at, "endedAt": ended, "day": ms_day(ended),
        "durationMs": j.started_at.map(|s| (ended - s).max(0)),
        "file": j.file.as_ref().map(|f| json!({ "name": f.name, "bytes": f.bytes })),
        "error": j.error, "mailError": j.mail_error, "warning": j.warning, "stoppedBy": j.stopped_by,
        "sheets": j.sheets,
        "failedClusters": j.failed_clusters.iter().map(|f| json!({ "clusterId": f.cluster_id, "reason": f.reason })).collect::<Vec<_>>(),
        "figures": {
            "daysDone": j.progress.done, "daysTotal": j.progress.total,
            "rows": rows, "clustersDone": clusters_done, "clustersFailed": j.failed_clusters.len(),
        },
        "writtenAt": now_ms,
    });
    if let Some(f) = file {
        doc["fileContent"] = json!({ "name": f.name, "base64": f.base64 });
    }
    doc
}

/// One thing that happened to an alert, as the core saw it or a page reported it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AlertEvent {
    /// `acknowledged`, `unacknowledged`, `ack_cleared`, `silenced`, `unsilenced`, `raised`, `cleared`.
    pub event: String,
    /// The alert key (`<clusterId>:<rule>…`), or the cluster id for a cluster-wide silence.
    pub key: String,
    pub cluster_id: Option<String>,
    /// A silence's `scope` (`cluster` / `alert`) and `target`.
    pub scope: Option<String>,
    pub target: Option<String>,
    /// From a page's report: the rule and level it saw.
    pub rule: Option<String>,
    pub level: Option<String>,
    pub by: String,
    pub at: u64,
    pub reason: Option<String>,
    pub note: Option<String>,
    pub until: Option<u64>,
    /// A page's `raised` whose start it may have missed (the page opened later).
    pub approx: Option<bool>,
    /// The person whose page reported it (`raised` / `cleared` only).
    pub reported_by: Option<String>,
}

pub fn alert_id(e: &AlertEvent) -> String {
    format!("{}|{}|{}", e.event, e.key, e.at)
}

pub fn alert_doc(e: &AlertEvent, now_ms: u64) -> Value {
    json!({
        "event": e.event, "key": e.key, "clusterId": e.cluster_id, "scope": e.scope, "target": e.target,
        "rule": e.rule, "level": e.level, "by": e.by, "at": e.at, "day": ms_day(e.at as i64),
        "reason": e.reason, "note": e.note, "until": e.until, "approx": e.approx, "reportedBy": e.reported_by,
        "writtenAt": now_ms,
    })
}

/// A page's `ALERT_EVENTS_PUT {events: [...]}`, checked: at most `ALERT_EVENTS_MAX`, each
/// `raised` or `cleared` with a sound key and a time. `Err` names the first thing wrong.
pub fn parse_alert_events(v: &Value, reported_by: &str, now_ms: u64) -> Result<Vec<AlertEvent>, String> {
    let list = v.get("events").and_then(Value::as_array).ok_or("events: a list")?;
    if list.len() > ALERT_EVENTS_MAX {
        return Err(format!("events: at most {ALERT_EVENTS_MAX} in one message"));
    }
    let mut out = vec![];
    for e in list {
        let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(String::from);
        let event = s("event").ok_or("event: raised or cleared")?;
        if event != "raised" && event != "cleared" {
            return Err(format!("event: {event:?} is not raised or cleared"));
        }
        let key = crate::play::acks::check_key(e.get("key").and_then(Value::as_str).unwrap_or(""))?.to_string();
        let at = e.get("at").and_then(Value::as_u64).filter(|a| *a > 0 && *a <= now_ms + 86_400_000).unwrap_or(now_ms);
        let bounded = |o: Option<String>| o.filter(|x| x.len() <= 200 && !x.chars().any(char::is_control));
        out.push(AlertEvent {
            event, key, at,
            rule: bounded(s("rule")), level: bounded(s("level")),
            approx: e.get("approx").and_then(Value::as_bool),
            by: reported_by.to_string(), reported_by: Some(reported_by.to_string()),
            ..AlertEvent::default()
        });
    }
    Ok(out)
}

/* ----------------------------------------------- templates ----------------------------------------------- */

fn template(prefix: &str, stream: &str, fields: &[(&str, Value)]) -> Value {
    let properties: Map<String, Value> = fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    json!({
        "index_patterns": [format!("{prefix}-{stream}-*")],
        // Above the history template's 200: on `<prefix>-reports-*` this one decides the mapping.
        "priority": 300,
        "_meta": { "managedBy": "ElasticPro", "contract": "docs/HISTORY.md", "stream": stream },
        "template": { "mappings": { "dynamic": false, "properties": properties } },
    })
}

/// The reports template's name, inside the prefix (`guard::history_guard` insists).
pub fn reports_template_name(prefix: &str) -> String {
    format!("{prefix}-{REPORTS_STREAM}-template")
}

pub fn alerts_template_name(prefix: &str) -> String {
    format!("{prefix}-{ALERTS_STREAM}-template")
}

/// Mappings only, `dynamic: false`, every field listed: nothing about settings or lifecycle.
pub fn reports_template_body(prefix: &str) -> Value {
    let kw = json!({ "type": "keyword" });
    let long = json!({ "type": "long" });
    let ms = json!({ "type": "date", "format": "epoch_millis" });
    let day = json!({ "type": "date", "format": "yyyy-MM-dd" });
    let text = json!({ "type": "text" });
    let boolean = json!({ "type": "boolean" });
    template(prefix, REPORTS_STREAM, &[
        ("jobId", kw.clone()), ("kind", kw.clone()), ("report", kw.clone()), ("status", kw.clone()),
        ("clusterIds", kw.clone()), ("clusterName", kw.clone()),
        ("period", json!({ "properties": { "from": day.clone(), "to": day.clone(), "label": kw.clone() } })),
        ("format", kw.clone()), ("mail", boolean.clone()), ("by", kw.clone()),
        ("createdAt", ms.clone()), ("startedAt", ms.clone()), ("endedAt", ms.clone()), ("day", day.clone()), ("durationMs", long.clone()),
        ("file", json!({ "properties": { "name": kw.clone(), "bytes": long.clone() } })),
        ("fileContent", json!({ "properties": { "name": kw.clone(), "base64": { "type": "binary" } } })),
        ("error", text.clone()), ("mailError", text.clone()), ("warning", text.clone()), ("stoppedBy", kw.clone()),
        ("sheets", kw.clone()),
        ("failedClusters", json!({ "properties": { "clusterId": kw.clone(), "reason": text.clone() } })),
        ("figures", json!({ "properties": { "daysDone": long.clone(), "daysTotal": long.clone(), "rows": long.clone(),
                                            "clustersDone": long.clone(), "clustersFailed": long.clone() } })),
        ("writtenAt", ms),
    ])
}

pub fn alerts_template_body(prefix: &str) -> Value {
    let kw = json!({ "type": "keyword" });
    let ms = json!({ "type": "date", "format": "epoch_millis" });
    let day = json!({ "type": "date", "format": "yyyy-MM-dd" });
    let text = json!({ "type": "text" });
    let boolean = json!({ "type": "boolean" });
    template(prefix, ALERTS_STREAM, &[
        ("event", kw.clone()), ("key", kw.clone()), ("clusterId", kw.clone()), ("scope", kw.clone()), ("target", kw.clone()),
        ("rule", kw.clone()), ("level", kw.clone()), ("by", kw.clone()), ("at", ms.clone()), ("day", day),
        ("reason", text.clone()), ("note", text), ("until", ms.clone()), ("approx", boolean), ("reportedBy", kw),
        ("writtenAt", ms),
    ])
}

/// The count of documents under `pattern`: the cheapest question the guard allows
/// (`_search`, `size=0`, `track_total_hits`), answered from `hits.total.value`.
pub fn count_path(pattern: &str) -> String {
    format!("/{pattern}/_search?size=0&track_total_hits=true&filter_path=hits.total&ignore_unavailable=true&allow_no_indices=true")
}

pub fn count_from(res: &Value) -> Option<u64> {
    res.pointer("/json/hits/total/value").and_then(Value::as_u64)
        .or_else(|| res.pointer("/json/hits/total").and_then(Value::as_u64))
}

/* ------------------------------------------------ the core ------------------------------------------------ */

use crate::auth::Caller;
use crate::bridge::Core;
use std::sync::Arc;

fn now_ms() -> u64 {
    crate::fleet::now_ms()
}

fn refused(kind: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "message": message.into() })
}

impl Core {
    fn routing_supported(&self) -> bool {
        self.edition().schedules() && self.data_routing.supported()
    }

    /// The routing in force (`DataRouting::current`, with whether the store is armed).
    pub(crate) fn routing(&self) -> Routing {
        let armed = self.history_store.stored.read().armed;
        self.data_routing.current(armed)
    }

    /// Whether a record of `kind` is queued for the store now (`admits`, the one definition,
    /// with the store's gates as they stand). Off hosted nothing is ever queued.
    pub(crate) fn routing_admits(&self, kind: Kind) -> bool {
        self.routing_supported() && admits(self.routing().mode(kind), self.history_writes_open().is_ok())
    }

    /// Records another process left in the spool (the report worker's): each is queued when
    /// the routing admits it now, else let go — and its file removed either way.
    pub(crate) fn routing_drain_spool(&self) {
        if !self.routing_supported() {
            return;
        }
        let mut taken = 0usize;
        for (path, rec) in self.data_routing.spooled() {
            if let Some(kind) = rec.as_ref().and_then(|s| Kind::of_stream(&s.stream)) {
                if self.routing_admits(kind) {
                    self.history_store.enqueue(vec![rec.expect("a parsed record").into_queued()]);
                    taken += 1;
                }
            }
            let _ = std::fs::remove_file(&path);
        }
        if taken > 0 {
            tracing::info!(target: "audit", queued = taken, "backend routing: spooled records queued for the store");
        }
    }

    /// A report job ended (`report_work`): its record goes to the spool for the writer's tick —
    /// the job may have run in the worker process, whose queue nobody sends. Blocking (reads
    /// the file when asked to carry it): call it off the async runtime.
    pub(crate) fn routing_report_ended(&self, job: &Job) {
        if !self.routing_supported() {
            return;
        }
        let routing = self.routing();
        if !routing.reports.sends_to_store() {
            return;
        }
        let now = now_ms();
        let carried = job.file.as_ref().filter(|_| routing.report_files).filter(|f| f.bytes <= REPORT_FILE_MAX_BYTES)
            .and_then(|f| self.reports.file_path(&job.id, &f.name).map(|p| (f.name.clone(), p)))
            .and_then(|(name, p)| std::fs::read(p).ok().map(|b| (name, b)));
        let doc = report_doc(job, carried.as_ref().map(|(name, b)| {
            use base64::Engine as _;
            FileCarried { name, base64: base64::engine::general_purpose::STANDARD.encode(b) }
        }), now);
        let day = doc["day"].as_str().unwrap_or_default().to_string();
        let s = Spooled { stream: REPORTS_STREAM.into(), cluster: job.cluster_id.clone(), id: job.id.clone(), day, at: now, doc };
        match self.data_routing.spool(&s) {
            Ok(()) => tracing::info!(target: "audit", job = %job.id, report = job.report.as_str(), "backend routing: report record spooled for the store"),
            Err(e) => tracing::warn!(job = %job.id, "backend routing: the report record could not be spooled: {e}"),
        }
    }

    /// Something happened to an alert in this process (an acknowledgement, a silence, a
    /// page's `raised`/`cleared`): queued when the routing admits it. The built-in record
    /// (acks.json, silences.json) was already written by the caller; this never waits on it.
    pub(crate) fn routing_alert_event(&self, e: AlertEvent) {
        if !self.routing_admits(Kind::Alerts) {
            return;
        }
        let now = now_ms();
        let day = ms_day(e.at as i64);
        let cluster = e.cluster_id.clone().unwrap_or_default();
        let doc = alert_doc(&e, now);
        self.history_store.enqueue(vec![((ALERTS_STREAM.into(), cluster, alert_id(&e)), Queued { day, doc, tries: 0 })]);
    }

    /// `DATA_ROUTING_GET` / `_SET` / `_STATUS`: admin (auth.rs); SET is fleet-wide, so a limited
    /// admin is refused.
    pub(crate) async fn data_routing_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if !self.routing_supported() {
            return json!({ "ok": false, "supported": false,
                           "message": "backend routing is hosted only: the server is the one edition that keeps records when nobody is looking" });
        }
        let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "admin".into());
        match t {
            "DATA_ROUTING_GET" => self.routing_view(),
            "DATA_ROUTING_STATUS" => self.routing_status().await,
            "DATA_ROUTING_SET" => {
                if caller.is_some_and(Caller::limited) {
                    return refused("forbidden", "backend routing is fleet-wide: an admin limited to some clusters cannot change it");
                }
                let next = match parse_incoming(msg.get("routing").unwrap_or(&Value::Null), &self.routing()) {
                    Ok(r) => r,
                    Err(e) => return refused("bad_request", e),
                };
                match self.data_routing.set(next, &by, now_ms()) {
                    Ok(r) => {
                        tracing::info!(target: "audit", user = %by, history = r.history.as_str(), reports = r.reports.as_str(),
                                       alerts = r.alerts.as_str(), report_files = r.report_files, "backend routing set");
                        self.routing_view()
                    }
                    Err(e) => json!({ "ok": false, "message": format!("could not save: {e}") }),
                }
            }
            _ => refused("bad_message", format!("Unknown message type {t:?}")),
        }
    }

    /// The store as the routing sees it: configured, its gates, whether it can be written now.
    fn routing_store_view(&self) -> Value {
        let s = self.history_store.stored.read().clone();
        let st = self.history_store.status.lock().clone();
        json!({
            "configured": s.configured(), "url": s.url, "prefix": s.prefix(),
            "permitted": crate::history_store::permitted(), "armed": s.armed, "testOk": s.test_current(),
            "writing": self.history_writes_open().err(),
            "lastSuccessAt": st.last_success_at, "lastError": st.last_error, "lastErrorAt": st.last_error_at,
            "queue": self.history_store.queue_len(), "dropped": st.dropped,
        })
    }

    fn routing_view(&self) -> Value {
        let modes: Vec<Value> = [Mode::Builtin, Mode::Copy, Mode::Es].iter().map(|m| json!({ "id": m.as_str(), "label": m.label() })).collect();
        json!({
            "ok": true, "supported": true,
            "routing": self.routing().public(),
            "modes": modes,
            "store": self.routing_store_view(),
        })
    }

    /// Where the kind's built-in record lives.
    fn routing_builtin_paths(&self, kind: Kind) -> Vec<PathBuf> {
        let Some(data) = self.data_dir() else { return vec![] };
        match kind {
            Kind::History => self.volume.store.as_ref().map(|s| vec![s.root().to_path_buf()]).unwrap_or_default(),
            Kind::Reports => self.reports.dir().into_iter().collect(),
            Kind::Alerts => vec![data.join(crate::play::acks::FILE), data.join("silences.json")],
        }
    }

    /// The documents under `pattern` on the store, within `COUNT_FOR_MS`: `Ok(count)`, or why not.
    async fn routing_count(self: &Arc<Self>, pattern: &str) -> Result<u64, String> {
        let now = now_ms();
        if let Some(cached) = self.data_routing.count_cached(pattern, now) {
            return cached.ok_or_else(|| "the store did not answer (asked again in a minute)".into());
        }
        let mut req = self.history_req("POST", count_path(pattern), Some("{}".into()), 8_000);
        req.class = crate::gate::Class::Interactive;
        let res = self.es_req(req).await;
        let n = count_from(&res).filter(|_| res.get("ok").and_then(Value::as_bool) == Some(true));
        self.data_routing.count_note(pattern, now, n);
        n.ok_or_else(|| format!("the store did not answer: {}", res.get("message").and_then(Value::as_str).unwrap_or("request failed")))
    }

    /// `DATA_ROUTING_STATUS`: per kind, where it goes, how long each side keeps it, how big it
    /// is now and whether it is reaching the store — plus the built-in store's size and free disk.
    async fn routing_status(self: &Arc<Self>) -> Value {
        let routing = self.routing();
        let data = self.data_dir().map(Path::to_path_buf);
        let paths: Vec<(Kind, Vec<PathBuf>)> = Kind::ALL.iter().map(|k| (*k, self.routing_builtin_paths(*k))).collect();
        // The walks, off the runtime.
        let sizes = tokio::task::spawn_blocking(move || {
            let whole = data.as_ref().map(|d| builtin_size(std::slice::from_ref(d))).unwrap_or_default();
            let disk = data.as_ref().and_then(|d| crate::health::statvfs(d));
            let per: BTreeMap<Kind, BuiltinSize> = paths.into_iter().map(|(k, p)| (k, builtin_size(&p))).collect();
            (whole, disk, per)
        }).await.ok();
        let (whole, disk, per) = sizes.unwrap_or_default();
        let keep_months = {
            let raw = self.volume_config().await.ok().flatten();
            self.volume_resolve(raw.as_ref(), None, None).settings.keep_months
        };
        let store = self.routing_store_view();
        let store_configured = store["configured"] == json!(true);
        let not_writing = self.history_writes_open().err();
        let counts = self.history_store.queue_counts();
        let prefix = self.history_store.stored.read().prefix().to_string();
        let mut kinds = Map::new();
        for k in Kind::ALL {
            let mode = routing.mode(k);
            let streams: Vec<&str> = match k {
                Kind::History => HISTORY_STREAMS.to_vec(),
                Kind::Reports => vec![REPORTS_STREAM],
                Kind::Alerts => vec![ALERTS_STREAM],
            };
            let queued: usize = streams.iter().map(|s| counts.get(*s).copied().unwrap_or(0)).sum();
            let (state, line) = status_line(mode, not_writing.as_deref(), queued);
            // Documents on the store: asked only when something of this kind is routed there
            // and a store is configured; unknown otherwise, never 0.
            let (docs, docs_note) = if !mode.sends_to_store() {
                (None, Some("not asked: this kind is kept in the built-in store only".to_string()))
            } else if !store_configured {
                (None, Some("no Elasticsearch store is configured".to_string()))
            } else {
                let mut total = 0u64;
                let mut why = None;
                for p in k.patterns(&prefix) {
                    match self.routing_count(&p).await {
                        Ok(n) => total += n,
                        Err(e) => { why = Some(e); break; }
                    }
                }
                match why { None => (Some(total), None), Some(w) => (None, Some(w)) }
            };
            let kept_builtin = match k {
                Kind::History => format!("{keep_months} months (the volume record's keepMonths)"),
                Kind::Reports => format!("{} days for the files · the last {} jobs", crate::report::KEEP_FILE_DAYS, crate::report::jobs::KEEP_FINISHED),
                Kind::Alerts => "while acknowledged or silenced (the live state)".to_string(),
            };
            kinds.insert(k.as_str().into(), json!({
                "mode": mode, "label": mode.label(), "state": state, "line": line,
                "keptFor": { "builtin": kept_builtin, "store": STORE_KEPT_FOR },
                "builtin": { "size": per.get(&k).cloned().unwrap_or_default(), "writing": true },
                "store": { "docs": docs, "docsNote": docs_note, "queued": queued, "writing": not_writing.is_none(), "why": not_writing },
            }));
        }
        json!({
            "ok": true, "supported": true,
            "routing": routing.public(),
            "builtin": {
                "dir": self.data_dir(), "size": whole,
                "diskTotal": disk.map(|(t, _)| t), "diskFree": disk.map(|(_, f)| f),
            },
            "store": store,
            "kinds": kinds,
        })
    }

    /// `ALERT_EVENTS_PUT {events}`: a page reports the alerts it saw raised and cleared (the
    /// core evaluates no alert itself). A user's, on the clusters they see; the same event
    /// from another page within `ALERT_EVENT_DEDUPE_MS` is dropped; a cluster the key does not
    /// name is refused, never guessed.
    pub(crate) fn alert_events_put(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        if !self.routing_supported() {
            return json!({ "ok": true, "supported": false, "accepted": 0, "dropped": 0 });
        }
        let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
        let now = now_ms();
        let events = match parse_alert_events(msg, &by, now) {
            Ok(e) => e,
            Err(e) => return refused("bad_request", e),
        };
        let known: Vec<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        let visible: std::collections::HashSet<String> = self.fleet_visible(caller).into_iter().collect();
        // Visibility first, for the whole list: a refused message queues nothing.
        if events.iter().any(|e| crate::silences::cluster_of("alert", &e.key, &known).is_some_and(|c| !visible.contains(c))) {
            return refused("forbidden", "that alert is on a cluster you cannot see");
        }
        let (mut accepted, mut dropped, mut unknown) = (0usize, 0usize, 0usize);
        for mut e in events {
            let Some(cluster) = crate::silences::cluster_of("alert", &e.key, &known) else { unknown += 1; continue };
            e.cluster_id = Some(cluster.clone());
            if !self.data_routing.alert_event_is_new(&e.event, &e.key, now) {
                dropped += 1;
                continue;
            }
            accepted += 1;
            self.routing_alert_event(e);
        }
        if accepted > 0 {
            tracing::info!(target: "audit", user = %by, accepted, dropped, unknown, "alert events reported by a page");
        }
        json!({ "ok": true, "supported": true, "accepted": accepted, "dropped": dropped, "unknown": unknown,
                "routed": self.routing().alerts.sends_to_store() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::{history_guard, Writes};
    use crate::report::jobs::{Format, Job, Kind as JobKind, Status};
    use crate::report::period;

    #[test]
    fn copy_queues_only_while_the_store_can_be_written_and_es_always() {
        assert!(!admits(Mode::Builtin, true) && !admits(Mode::Builtin, false));
        assert!(admits(Mode::Copy, true) && !admits(Mode::Copy, false));
        assert!(admits(Mode::Es, true) && admits(Mode::Es, false));
    }

    #[test]
    fn the_status_line_says_where_a_record_is_and_why() {
        assert_eq!(status_line(Mode::Builtin, Some("anything"), 9).0, "builtin");
        assert_eq!(status_line(Mode::Copy, None, 0), ("writing", "writing".into()));
        assert_eq!(status_line(Mode::Es, None, 3).1, "writing · 3 queued");
        let (st, line) = status_line(Mode::Es, Some("Write history is off"), 12);
        assert_eq!(st, "queued");
        assert!(line.contains("kept in the built-in store meanwhile") && line.contains("12 queued"), "{line}");
        let (st, line) = status_line(Mode::Copy, Some("Write history is off"), 0);
        assert_eq!(st, "paused");
        assert!(line.contains("not copying") && line.contains("built-in store"), "{line}");
    }

    #[test]
    fn incoming_routing_keeps_what_it_does_not_name_and_refuses_what_is_not_a_mode() {
        let cur = Routing { reports: Mode::Copy, ..Routing::default() };
        let next = parse_incoming(&json!({ "alerts": "es", "reportFiles": true }), &cur).unwrap();
        assert_eq!((next.history, next.reports, next.alerts, next.report_files), (Mode::Builtin, Mode::Copy, Mode::Es, true));
        assert!(parse_incoming(&json!({ "history": "cluster" }), &cur).unwrap_err().contains("not builtin, copy or es"));
        assert!(parse_incoming(&json!({ "destination": "x" }), &cur).unwrap_err().contains("not a routing field"));
        assert!(parse_incoming(&json!("es"), &cur).is_err());
    }

    #[test]
    fn until_saved_history_follows_the_store_and_a_saved_choice_holds() {
        let r = DataRouting::open(None, true, true);
        assert_eq!(r.current(false), Routing::default(), "built-in for everything");
        assert_eq!(r.current(true).history, Mode::Copy, "an armed store is a copy of the history, as before this feature");
        assert_eq!(r.current(true).reports, Mode::Builtin);
        r.set(Routing::default(), "kd", 5).unwrap();
        assert_eq!(r.current(true).history, Mode::Builtin, "an admin's explicit built-in holds while the store is armed");
        assert_eq!(r.current(true).changed_by.as_deref(), Some("kd"));
    }

    #[test]
    fn reports_and_alerts_are_yearly_indices_and_their_templates_pass_the_guard() {
        assert_eq!(year_index("ep", REPORTS_STREAM, "2026-11-06").as_deref(), Some("ep-reports-2026"));
        assert_eq!(year_index("ep", ALERTS_STREAM, "nope"), None);
        for (name, body) in [(reports_template_name("ep"), reports_template_body("ep")), (alerts_template_name("ep"), alerts_template_body("ep"))] {
            let refused = history_guard(Writes::HistoryWrite, "ep", "PUT", &format!("/_index_template/{name}?create=true"), Some(&body.to_string()));
            assert_eq!(refused, None, "{name}");
            let s = body.to_string();
            assert!(!s.contains("settings") && !s.contains("lifecycle"), "mappings only");
            assert_eq!(body["template"]["mappings"]["dynamic"], json!(false));
            assert_eq!(body["priority"], json!(300), "above the history template's");
            assert_eq!(body["_meta"]["managedBy"], json!("ElasticPro"));
        }
        assert_eq!(reports_template_body("ep")["index_patterns"], json!(["ep-reports-*"]));
        // Every field a document carries is in its template (dynamic: false would otherwise lose it from search).
        let j = sample_job();
        let doc = report_doc(&j, Some(FileCarried { name: "r.xlsx", base64: "AAAA".into() }), 5);
        let props = &reports_template_body("ep")["template"]["mappings"]["properties"];
        for k in doc.as_object().unwrap().keys() {
            assert!(props.get(k).is_some(), "report field {k} is not mapped");
        }
        let a = alert_doc(&AlertEvent { event: "silenced".into(), key: "c1".into(), by: "kd".into(), at: 1_700_000_000_000, ..AlertEvent::default() }, 5);
        let props = &alerts_template_body("ep")["template"]["mappings"]["properties"];
        for k in a.as_object().unwrap().keys() {
            assert!(props.get(k).is_some(), "alert field {k} is not mapped");
        }
        assert!(history_guard(Writes::HistoryRead, "ep", "POST", &count_path("ep-alerts-*"), Some("{}")).is_none(), "the count is a read the guard allows");
    }

    fn sample_job() -> Job {
        let mut j = Job::new(JobKind::Cluster, vec!["prod".into()], "Production".into(),
                             period::last7(chrono::NaiveDate::from_ymd_opt(2026, 11, 6).unwrap()), Format::Xlsx, false, "kd", 1_000);
        j.id = "abc123".into();
        j.status = Status::Done;
        j.started_at = Some(2_000);
        j.ended_at = Some(1_762_400_000_000);
        j
    }

    #[test]
    fn a_report_record_counts_what_the_job_counted_and_nothing_else() {
        let j = sample_job();
        let d = report_doc(&j, None, 9);
        assert_eq!(d["jobId"], json!("abc123"));
        assert_eq!(d["status"], json!("done"));
        assert_eq!(d["figures"]["rows"], Value::Null, "a volume report counts days, not rows: unknown, not 0");
        assert_eq!(d["figures"]["clustersDone"], Value::Null);
        assert_eq!(d["day"], json!("2025-11-06"), "the UTC day the job ended");
        assert!(d.get("fileContent").is_none(), "no file unless asked");
        assert_eq!(d["durationMs"], json!(1_762_400_000_000i64 - 2_000));
    }

    #[test]
    fn a_pages_alert_events_are_bounded_checked_and_deduplicated() {
        let now = 1_700_000_000_000u64;
        let ev = parse_alert_events(&json!({ "events": [
            { "event": "raised", "key": "c1:disk", "rule": "disk", "level": "crit", "at": now - 5, "approx": true },
            { "event": "cleared", "key": "c1:disk", "at": now + 86_400_000 * 2 },
        ] }), "ann", now).unwrap();
        assert_eq!(ev.len(), 2);
        assert_eq!((ev[0].event.as_str(), ev[0].at, ev[0].approx, ev[0].reported_by.as_deref()), ("raised", now - 5, Some(true), Some("ann")));
        assert_eq!(ev[1].at, now, "a time in the future is now");
        assert_eq!(alert_id(&ev[0]), format!("raised|c1:disk|{}", now - 5));
        assert!(parse_alert_events(&json!({ "events": [{ "event": "acknowledged", "key": "c1:x" }] }), "ann", now).is_err(), "a page reports only what it sees");
        assert!(parse_alert_events(&json!({ "events": [{ "event": "raised", "key": "" }] }), "ann", now).is_err());
        let many: Vec<Value> = (0..=ALERT_EVENTS_MAX).map(|i| json!({ "event": "raised", "key": format!("c:{i}") })).collect();
        assert!(parse_alert_events(&json!({ "events": many }), "ann", now).is_err());
        let r = DataRouting::open(None, true, true);
        assert!(r.alert_event_is_new("raised", "c1:disk", now));
        assert!(!r.alert_event_is_new("raised", "c1:disk", now + 60_000), "the same event from another page");
        assert!(r.alert_event_is_new("cleared", "c1:disk", now + 60_000));
        assert!(r.alert_event_is_new("raised", "c1:disk", now + ALERT_EVENT_DEDUPE_MS + 1), "later: a new episode");
    }

    #[test]
    fn a_size_nobody_can_read_is_unknown_not_zero() {
        let none = builtin_size(&[PathBuf::from("/nonexistent/elasticpro-routing-test")]);
        assert_eq!(none, BuiltinSize { bytes: None, files: None, truncated: false });
        let dir = std::env::temp_dir().join(format!("ep-routing-size-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.json"), b"12345").unwrap();
        let some = builtin_size(&[dir.clone(), PathBuf::from("/nonexistent/x")]);
        assert_eq!((some.bytes, some.files), (Some(5), Some(1)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_spool_round_trips_a_record() {
        let dir = std::env::temp_dir().join(format!("ep-routing-spool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = DataRouting::open(Some(&dir), true, false);
        let s = Spooled { stream: REPORTS_STREAM.into(), cluster: "prod".into(), id: "job/1".into(), day: "2026-11-06".into(), at: 7, doc: json!({ "jobId": "job/1" }) };
        r.spool(&s).unwrap();
        let got = r.spooled();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1.as_ref(), Some(&s));
        let (k, q) = got[0].1.clone().unwrap().into_queued();
        assert_eq!(k, ("reports".into(), "prod".into(), "job/1".into()));
        assert_eq!(q.day, "2026-11-06");
        assert!(r.spool_dir().unwrap().starts_with(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
