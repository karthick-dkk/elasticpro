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
/// A page's `raised` or `cleared` for the same alert, from the same person, within this
/// window is the same event.
pub const ALERT_EVENT_DEDUPE_MS: u64 = 15 * 60_000;
/// Events one `ALERT_EVENTS_PUT` may carry.
pub const ALERT_EVENTS_MAX: usize = 200;
/// Events one account may report in `ALERT_EVENTS_WINDOW_MS`, over every message (counted as
/// sent, accepted or not): past it the message is refused `too_many` and nothing is queued.
pub const ALERT_EVENTS_PER_WINDOW: usize = 200;
pub const ALERT_EVENTS_WINDOW_MS: u64 = 15 * 60_000;
/// Remembered `(reporter, event, key)` at most; past it the oldest are forgotten first.
pub const ALERT_RECENT_MAX: usize = 50_000;
/// A page's own `at` is believed within this window around now; outside it, now is used.
pub const ALERT_AT_PAST_MS: u64 = 48 * 3_600_000;
pub const ALERT_AT_FUTURE_MS: u64 = 5 * 60_000;
/// The spool holds at most this much; a record that would take it over is not spooled.
pub const SPOOL_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// The alert rule families the pages raise (`ui/js/core/alert-rules.js` ids — one list, the
/// unit test holds the two together) plus Play's `node-left`. An alert key is
/// `<clusterId>:<family>[:<instance>]`; a key whose family is not one of these is refused.
pub const ALERT_RULE_IDS: [&str; 18] = [
    "unreachable", "health", "disk", "disk-balance", "disk-unaccounted", "capacity", "no-master", "master-changed",
    "ilm", "slm-mode", "slm-fail", "slm-stale", "repo", "log-delay", "heap", "automation", "volume",
    crate::play::NODE_LEFT_ACK,
];

/// The rule family an alert key names (`<clusterId>:<family>…`), when it is a known one.
pub fn known_alert_family(key: &str) -> Option<&'static str> {
    let family = key.split(':').nth(1)?;
    ALERT_RULE_IDS.iter().copied().find(|f| *f == family)
}
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
    /// `(reporter, event, key)` → when that page last reported it: a second report inside
    /// the window is the same event. Entries past the window go; past `ALERT_RECENT_MAX` the
    /// oldest go first.
    recent_alerts: Mutex<BTreeMap<(String, String, String), u64>>,
    /// Per account: `(window start, events sent in it)` for `ALERT_EVENTS_PUT`.
    alert_rate: Mutex<BTreeMap<String, (u64, usize)>>,
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
                      recent_alerts: Mutex::new(BTreeMap::new()), alert_rate: Mutex::new(BTreeMap::new()), counts: Mutex::new(BTreeMap::new()) }
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
    /// Refused when the record is over `QUEUED_DOC_MAX_BYTES` or the spool would pass
    /// `SPOOL_MAX_BYTES` (the tick drains it every minute; a spool that grows is a core that
    /// is not ticking, and more files would not help).
    pub fn spool(&self, s: &Spooled) -> Result<(), String> {
        let dir = self.spool.as_ref().ok_or("no data directory")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let bytes = serde_json::to_vec(s).map_err(|e| e.to_string())?;
        if bytes.len() > crate::history_store::QUEUED_DOC_MAX_BYTES {
            return Err(format!("the record is {} bytes, over the {} allowed", bytes.len(), crate::history_store::QUEUED_DOC_MAX_BYTES));
        }
        let held: u64 = std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum();
        if held + bytes.len() as u64 > SPOOL_MAX_BYTES {
            return Err(format!("the spool holds {held} bytes, its limit is {SPOOL_MAX_BYTES}: is the core's history-store tick running?"));
        }
        let safe: String = s.id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(80).collect();
        let name = format!("{}-{safe}-{}.json", s.stream, s.at);
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

    /// Whether `by`'s page reporting `event` for `key` is new, and remember it. Entries older
    /// than the window are forgotten; past `ALERT_RECENT_MAX` the oldest go first (never all).
    pub fn alert_event_is_new(&self, by: &str, event: &str, key: &str, now_ms: u64) -> bool {
        let mut m = self.recent_alerts.lock();
        m.retain(|_, at| now_ms.saturating_sub(*at) < ALERT_EVENT_DEDUPE_MS);
        let k = (by.to_string(), event.to_string(), key.to_string());
        if m.contains_key(&k) {
            return false;
        }
        if m.len() >= ALERT_RECENT_MAX {
            let mut by_age: Vec<(u64, (String, String, String))> = m.iter().map(|(k, at)| (*at, k.clone())).collect();
            by_age.sort();
            for (_, k) in by_age.into_iter().take(m.len() + 1 - ALERT_RECENT_MAX) {
                m.remove(&k);
            }
        }
        m.insert(k, now_ms);
        true
    }

    /// Count `n` events against `by`'s window: `Err(message)` when the account is past
    /// `ALERT_EVENTS_PER_WINDOW` in `ALERT_EVENTS_WINDOW_MS` (the events still count).
    pub fn alert_events_allow(&self, by: &str, n: usize, now_ms: u64) -> Result<(), String> {
        let mut m = self.alert_rate.lock();
        m.retain(|_, (start, _)| now_ms.saturating_sub(*start) < ALERT_EVENTS_WINDOW_MS);
        let e = m.entry(by.to_string()).or_insert((now_ms, 0));
        e.1 = e.1.saturating_add(n);
        if e.1 > ALERT_EVENTS_PER_WINDOW {
            let left = (e.0 + ALERT_EVENTS_WINDOW_MS).saturating_sub(now_ms) / 60_000 + 1;
            return Err(format!("too many alert events from this account: at most {ALERT_EVENTS_PER_WINDOW} in {} minutes (try again in {left} min)", ALERT_EVENTS_WINDOW_MS / 60_000));
        }
        Ok(())
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

/// A report file as its record refers to it until it is sent: name, size and digest. The
/// content is read when the bulk is cut (`materialise_report_doc`), never kept in the queue
/// or the spool.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileRef {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// `sha256` of a file, hex, with its size.
pub fn file_digest(path: &Path) -> std::io::Result<(u64, String)> {
    use sha2::Digest as _;
    let bytes = std::fs::read(path)?;
    Ok((bytes.len() as u64, hex::encode(sha2::Sha256::digest(&bytes))))
}

/// A queued report document on its way out: its `fileRef`, if any, becomes `fileContent`
/// (the file read now, checked against the size and digest recorded when the job ended) or,
/// when the file is gone or changed, a `fileNote` saying so. The reference itself never
/// reaches the store.
pub fn materialise_report_doc(mut doc: Value, path: Option<&Path>) -> Value {
    let Some(r) = doc.get("fileRef").cloned().and_then(|v| serde_json::from_value::<FileRef>(v).ok()) else {
        if let Some(o) = doc.as_object_mut() { o.remove("fileRef"); }
        return doc;
    };
    if let Some(o) = doc.as_object_mut() {
        o.remove("fileRef");
    }
    let note = match path.map(file_digest) {
        None => format!("the file {} was not carried: no such path on the server", r.name),
        Some(Err(_)) => format!("the file {} is no longer on the server (report files are kept {} days)", r.name, crate::report::KEEP_FILE_DAYS),
        Some(Ok((len, digest))) if len != r.bytes || digest != r.sha256 => format!("the file {} changed since the report ended: not carried", r.name),
        Some(Ok(_)) => {
            use base64::Engine as _;
            match path.and_then(|p| std::fs::read(p).ok()) {
                Some(b) => {
                    doc["fileContent"] = json!({ "name": r.name, "base64": base64::engine::general_purpose::STANDARD.encode(b), "sha256": r.sha256 });
                    return doc;
                }
                None => format!("the file {} could not be read", r.name),
            }
        }
    };
    doc["fileNote"] = json!(note);
    doc
}

/// One report job as its record on the store: what it was, what it made, what it measured.
/// `figures` are the job's own counts, `null` where the job did not count (a volume report
/// counts days, not rows).
pub fn report_doc(j: &Job, file: Option<FileRef>, now_ms: u64) -> Value {
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
        doc["fileRef"] = json!(f);
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
        if known_alert_family(&key).is_none() {
            return Err(format!("key: {key:?} names no alert rule (<clusterId>:<rule>…)"));
        }
        let at = e.get("at").and_then(Value::as_u64)
            .filter(|a| *a + ALERT_AT_PAST_MS >= now_ms && *a <= now_ms + ALERT_AT_FUTURE_MS).unwrap_or(now_ms);
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
        ("fileContent", json!({ "properties": { "name": kw.clone(), "base64": { "type": "binary" }, "sha256": kw.clone() } })),
        ("fileNote", text.clone()),
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
    /// the routing admits it now, else let go (its file removed). The files of the records
    /// queued are handed back: the tick removes them once the queue is on disk, so a crash in
    /// between loses nothing (the record is queued again, under the same key).
    pub(crate) fn routing_drain_spool(&self) -> Vec<PathBuf> {
        if !self.routing_supported() {
            return vec![];
        }
        let mut taken = vec![];
        for (path, rec) in self.data_routing.spooled() {
            if let Some(kind) = rec.as_ref().and_then(|s| Kind::of_stream(&s.stream)) {
                if self.routing_admits(kind) {
                    self.history_store.enqueue(vec![rec.expect("a parsed record").into_queued()]);
                    taken.push(path);
                    continue;
                }
            }
            let _ = std::fs::remove_file(&path);
        }
        if !taken.is_empty() {
            tracing::info!(target: "audit", queued = taken.len(), "backend routing: spooled records queued for the store");
        }
        taken
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
        // Carried as a reference (name, size, digest): the file is read when the record is sent.
        let carried = job.file.as_ref().filter(|_| routing.report_files).filter(|f| f.bytes <= REPORT_FILE_MAX_BYTES)
            .and_then(|f| self.reports.file_path(&job.id, &f.name).map(|p| (f.name.clone(), p)))
            .and_then(|(name, p)| file_digest(&p).ok().map(|(bytes, sha256)| FileRef { name, bytes, sha256 }));
        let doc = report_doc(job, carried, now);
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
                let before = self.routing();
                match self.data_routing.set(next, &by, now_ms()) {
                    Ok(r) => {
                        tracing::info!(target: "audit", user = %by, history = r.history.as_str(), reports = r.reports.as_str(),
                                       alerts = r.alerts.as_str(), report_files = r.report_files, "backend routing set");
                        // Opting out takes effect now: what was waiting for the store of a kind
                        // routed back to built-in goes (counted, audited); files no longer
                        // carried come out of the queued report records.
                        for k in Kind::ALL {
                            if before.mode(k).sends_to_store() && !r.mode(k).sends_to_store() {
                                let streams: Vec<&str> = match k { Kind::History => HISTORY_STREAMS.to_vec(), Kind::Reports => vec![REPORTS_STREAM], Kind::Alerts => vec![ALERTS_STREAM] };
                                let mut dropped = 0usize;
                                for s in &streams {
                                    let n = self.history_store.drop_stream(s);
                                    if n > 0 {
                                        let mut st = self.history_store.status.lock();
                                        st.dropped += n as u64;
                                        *st.dropped_by_stream.entry((*s).into()).or_insert(0) += n as u64;
                                        dropped += n;
                                    }
                                }
                                if dropped > 0 {
                                    tracing::info!(target: "audit", user = %by, kind = k.as_str(), dropped, "backend routing: queued records let go, the kind is kept built-in");
                                }
                            }
                        }
                        if before.report_files && !r.report_files {
                            let n = self.history_store.strip_report_files();
                            if n > 0 {
                                tracing::info!(target: "audit", user = %by, records = n, "backend routing: report files taken out of the queued records");
                            }
                        }
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
        let (stream_errors, dropped_by) = { let st = self.history_store.status.lock(); (st.stream_errors.clone(), st.dropped_by_stream.clone()) };
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
            let dropped: u64 = streams.iter().map(|s| dropped_by.get(*s).copied().unwrap_or(0)).sum();
            let stream_error = streams.iter().find_map(|s| stream_errors.get(*s).cloned());
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
                // The built-in record's own result is not measured here: no claim is made about it.
                "builtin": { "size": per.get(&k).cloned().unwrap_or_default() },
                "store": { "docs": docs, "docsNote": docs_note, "queued": queued, "dropped": dropped,
                           "writing": not_writing.is_none() && stream_error.is_none(), "why": not_writing.clone().or(stream_error) },
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
        // Counted as sent, before anything is looked at: a flood of junk is a flood.
        let sent = msg.get("events").and_then(Value::as_array).map(Vec::len).unwrap_or(1).max(1);
        if let Err(e) = self.data_routing.alert_events_allow(&by, sent, now) {
            return refused("too_many", e);
        }
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
            if !self.data_routing.alert_event_is_new(&by, &e.event, &e.key, now) {
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
        let doc = report_doc(&j, Some(FileRef { name: "r.xlsx".into(), bytes: 4, sha256: "x".into() }), 5);
        assert!(doc.get("fileRef").is_some() && doc.get("fileContent").is_none(), "queued: a reference, never the content");
        let props = &reports_template_body("ep")["template"]["mappings"]["properties"];
        // As sent (the reference becomes content or a note), every field is mapped.
        let gone = materialise_report_doc(doc.clone(), Some(Path::new("/nonexistent/ep-report.xlsx")));
        assert!(gone.get("fileRef").is_none() && gone["fileNote"].as_str().unwrap().contains("no longer on the server"), "{gone}");
        for k in gone.as_object().unwrap().keys() {
            assert!(props.get(k).is_some(), "report field {k} is not mapped");
        }
        assert!(props["fileContent"]["properties"].get("sha256").is_some());
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
        assert!(d.get("fileContent").is_none() && d.get("fileRef").is_none(), "no file unless asked");
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
        let many: Vec<Value> = (0..=ALERT_EVENTS_MAX).map(|i| json!({ "event": "raised", "key": format!("c{i}:disk") })).collect();
        assert!(parse_alert_events(&json!({ "events": many }), "ann", now).is_err());
        // A key must name a rule family the pages raise; free text is refused by name.
        let junk = parse_alert_events(&json!({ "events": [{ "event": "raised", "key": "c1:pwned-by-script" }] }), "ann", now).unwrap_err();
        assert!(junk.contains("names no alert rule"), "{junk}");
        assert!(parse_alert_events(&json!({ "events": [{ "event": "raised", "key": "c1" }] }), "ann", now).is_err(), "no family at all");
        assert!(parse_alert_events(&json!({ "events": [{ "event": "raised", "key": "c1:slm-stale:daily" }] }), "ann", now).is_ok(), "an instance suffix is fine");
        assert!(parse_alert_events(&json!({ "events": [{ "event": "cleared", "key": "c1:node-left" }] }), "ann", now).is_ok(), "Play's node-left");
        // `at`: believed within 48 h back and 5 min ahead, else now.
        let at = |a: u64| parse_alert_events(&json!({ "events": [{ "event": "raised", "key": "c1:disk", "at": a }] }), "ann", now).unwrap()[0].at;
        assert_eq!(at(now - ALERT_AT_PAST_MS + 1), now - ALERT_AT_PAST_MS + 1);
        assert_eq!(at(now - ALERT_AT_PAST_MS - 1), now, "too far back");
        assert_eq!(at(now + ALERT_AT_FUTURE_MS), now + ALERT_AT_FUTURE_MS);
        assert_eq!(at(now + ALERT_AT_FUTURE_MS + 1), now, "too far ahead");
        // The same event from the same page is one; from another person it is theirs.
        let r = DataRouting::open(None, true, true);
        assert!(r.alert_event_is_new("ann", "raised", "c1:disk", now));
        assert!(!r.alert_event_is_new("ann", "raised", "c1:disk", now + 60_000), "the same event from the same page");
        assert!(r.alert_event_is_new("bob", "raised", "c1:disk", now + 60_000), "another person's page");
        assert!(r.alert_event_is_new("ann", "cleared", "c1:disk", now + 60_000));
        assert!(r.alert_event_is_new("ann", "raised", "c1:disk", now + ALERT_EVENT_DEDUPE_MS + 1), "later: a new episode");
        // Past the cap the oldest go first, never everything.
        for i in 0..ALERT_RECENT_MAX {
            r.alert_event_is_new("ann", "raised", &format!("c{i}:heap"), now + 1 + i as u64 % 1000);
        }
        assert!(!r.alert_event_is_new("ann", "raised", "c1:disk", now + 1001), "a recent one is still remembered after the trim");
        assert_eq!(r.recent_alerts.lock().len(), ALERT_RECENT_MAX);
    }

    #[test]
    fn an_account_may_report_only_so_many_events_in_a_window() {
        let r = DataRouting::open(None, true, true);
        let now = 1_700_000_000_000u64;
        assert!(r.alert_events_allow("ann", ALERT_EVENTS_PER_WINDOW, now).is_ok());
        let e = r.alert_events_allow("ann", 1, now + 1).unwrap_err();
        assert!(e.contains("too many alert events"), "{e}");
        assert!(r.alert_events_allow("bob", 1, now + 1).is_ok(), "another account's window");
        assert!(r.alert_events_allow("ann", 1, now + ALERT_EVENTS_WINDOW_MS).is_ok(), "the window passed");
    }

    #[test]
    fn the_rule_families_are_the_pages_alert_rules() {
        // One list: the Rust side names the families the UI's alert-rules.js produces, plus Play's node-left.
        let js = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../ui/js/core/alert-rules.js")).expect("ui/js/core/alert-rules.js");
        let re = regex::Regex::new(r"\{\s*id:\s*'([a-z-]+)'").unwrap();
        let mut from_js: Vec<&str> = re.captures_iter(&js).map(|c| c.get(1).unwrap().as_str()).collect();
        from_js.push(crate::play::NODE_LEFT_ACK);
        from_js.sort();
        from_js.dedup();
        let mut here: Vec<&str> = ALERT_RULE_IDS.to_vec();
        here.sort();
        assert_eq!(here, from_js, "ALERT_RULE_IDS and ui/js/core/alert-rules.js disagree");
        assert_eq!(known_alert_family("vm-1:slm-stale:daily"), Some("slm-stale"));
        assert_eq!(known_alert_family("vm-1"), None);
        assert_eq!(known_alert_family("vm-1:DISK"), None, "exact");
    }

    #[test]
    fn a_report_file_is_carried_as_sent_when_it_is_still_what_it_was() {
        let dir = std::env::temp_dir().join(format!("ep-routing-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("r.csv");
        std::fs::write(&p, b"a,b\n1,2\n").unwrap();
        let (bytes, sha256) = file_digest(&p).unwrap();
        let doc = report_doc(&sample_job(), Some(FileRef { name: "r.csv".into(), bytes, sha256: sha256.clone() }), 5);
        let sent = materialise_report_doc(doc.clone(), Some(&p));
        assert_eq!(sent["fileContent"]["sha256"], json!(sha256));
        assert_eq!(sent["fileContent"]["base64"], json!("YSxiCjEsMgo="));
        assert!(sent.get("fileRef").is_none() && sent.get("fileNote").is_none());
        std::fs::write(&p, b"changed").unwrap();
        let changed = materialise_report_doc(doc, Some(&p));
        assert!(changed.get("fileContent").is_none() && changed["fileNote"].as_str().unwrap().contains("changed since"), "{changed}");
        let _ = std::fs::remove_dir_all(&dir);
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
