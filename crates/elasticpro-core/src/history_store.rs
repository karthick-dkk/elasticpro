//! The history store (docs/HISTORY.md is the contract; read it first).
//!
//! A **dedicated** Elasticsearch endpoint — its own URL and credential, not one of the
//! monitored clusters — that mirrors what the core records, with a long history. The local
//! files stay the working store; this keeps everything, and the volume pages read it for the
//! days the local files no longer hold.
//!
//! ```text
//!   volume run ends ──▶ days it changed ─┐
//!   scheduled run ends ─▶ capacity doc ──┼─▶ queue (bounded, on disk) ──tick 60 s──▶ _bulk
//!   delay sink (destination: history) ──────────────────────────────── direct ──────▶ _bulk
//!   Copy existing history ─▶ every local month file, in pages ────────── direct ──────▶ _bulk
//!   VOLUME_DAILY / MONTHLY / MONTHLY_ALL, HISTORY_QUERY ─▶ bounded _search pages ◀─── store
//! ```
//!
//! **Writes are gated twice, by people, and by nothing else** (CLAUDE.md). The global
//! `readOnly` is not used — opening it would open every monitored cluster. Instead:
//!
//! 1. `HISTORY_STORE_WRITES=true` in config.txt (hosted). Without it the store can be
//!    configured and tested (reads only), never written. A start without it disarms (2).
//! 2. An admin armed it (*Write history*), which is refused until a *Test connection* has
//!    passed on the settings as they are now. Any change of address, route, TLS, prefix or
//!    credential disarms. Disarming stops writes at the next bulk.
//!
//! Both are checked where the request is built, at the chokepoint (`Core::es_req` gives a
//! store request `Writes::HistoryWrite` only while both stand) and again after the request
//! was admitted by the gate, right before it is sent (`Core::history_recheck`): a request
//! that waited for a slot while somebody disarmed or moved the store is not sent.
//! `guard::history_guard` holds every store request to exact shapes on the store's prefix.
//!
//! **Measures, not judgements.** The documents carry inputs (sizes, retention as typed, disk
//! by data role); required disk, buffers and shortfalls stay in the UI, one definition.
//!
//! **Unknown is not zero.** A store that cannot be reached is "in the history store · not
//! reachable", never a day of zeroes; a figure the core cannot measure is `null`; a read-back
//! that stopped at its bound says which days it did not read.

use crate::auth::Caller;
use crate::bridge::Core;
use crate::guard::{history_prefix_ok, history_prefix_reserved, Writes};
use crate::http::{ClusterSpec, EsRequest};
use crate::volume::schedule::{day_key, month_key, parse_day, utc_day};
use crate::volume::{Day, SourceTotals};
use chrono::{Duration, NaiveDate};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The id the store's requests are recorded and admitted under. Not a cluster id: the `@`
/// cannot come out of `cluster_save::config_ids`, so no monitored cluster can be it.
pub const STORE_ID: &str = "@history-store";
/// Who the store's requests say they are, in the Request Centre and as `X-Opaque-Id`.
pub const ORIGIN: &str = "history-store";
pub const DEFAULT_PREFIX: &str = "elasticpro-history";
pub const FILE: &str = "history-store.json";
pub const QUEUE_FILE: &str = "history-store-queue.json";
/// The config.txt key of the first gate.
pub const PERMIT_KEY: &str = "HISTORY_STORE_WRITES";
pub const PERMIT_HINT: &str = "set HISTORY_STORE_WRITES=true in config.txt";
/// One bulk holds at most this many documents …
pub const BULK_MAX_DOCS: usize = 500;
/// … and at most this many bytes of NDJSON.
pub const BULK_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Bulks one tick sends at most; the rest wait for the next.
pub const BULKS_PER_TICK: usize = 20;
/// Documents waiting at most. Past it the oldest days go, and the status says how many.
pub const QUEUE_MAX: usize = 20_000;
/// Days one read-back page returns (Elasticsearch's own default result window) …
pub const READ_BACK_PAGE: usize = 10_000;
/// … and pages one read-back reads at most. Beyond them the reply says which days it did not read.
pub const READ_BACK_PAGES: usize = 5;
/// Documents one `HISTORY_QUERY` returns at most.
pub const QUERY_MAX: usize = 5_000;
/// A store that did not answer is not asked again by a page for this long.
pub const UNREACHABLE_FOR_MS: u64 = 60_000;
/// Times one document is offered after the store refused it as malformed, before it is given up.
pub const REJECT_TRIES: u32 = 3;
/// The index template's name, inside the prefix (`guard::history_guard` insists).
pub fn template_name(prefix: &str) -> String {
    format!("{prefix}-template")
}

/* ----------------------------------------- settings ----------------------------------------- */

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    #[default]
    Basic,
    ApiKey,
    None,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthKind::Basic => "basic",
            AuthKind::ApiKey => "apiKey",
            AuthKind::None => "none",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Streams {
    #[serde(default = "yes")]
    pub volume: bool,
    #[serde(default = "yes")]
    pub capacity: bool,
    #[serde(default = "yes")]
    pub delay: bool,
}

fn yes() -> bool {
    true
}

impl Default for Streams {
    fn default() -> Streams {
        Streams { volume: true, capacity: true, delay: true }
    }
}

impl Streams {
    pub fn on(&self, stream: &str) -> bool {
        match stream {
            "volume" => self.volume,
            "capacity" => self.capacity,
            "delay" => self.delay,
            _ => false,
        }
    }
}

/// One privilege as the store answered it: `None` is "not checked" (security disabled on the
/// store, or not asked), never "no".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Privileges {
    pub create_doc: Option<bool>,
    pub create_index: Option<bool>,
    pub read: Option<bool>,
    /// The cluster privilege the index template needs.
    #[serde(default)]
    pub manage_index_templates: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub at: u64,
    pub by: String,
    pub ok: bool,
    /// What the settings were when it ran (`Stored::fingerprint`): a test of other settings
    /// does not let anybody arm these.
    pub fingerprint: String,
    pub version: Option<String>,
    pub cluster_name: Option<String>,
    pub security_enabled: Option<bool>,
    pub privileges: Privileges,
    pub message: Option<String>,
}

/// What `history-store.json` holds. The password or API key only sealed, bound to the
/// destination and the kind of credential it was typed for.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth: AuthKind,
    #[serde(default)]
    pub user: String,
    /// `ClusterSecrets::seal_own`, associated data `seal_aad(destination, kind)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<String>,
    #[serde(default)]
    pub sealed_for: String,
    /// The kind of credential sealed: switching basic ↔ API key needs it typed again.
    #[serde(default)]
    pub sealed_auth: Option<AuthKind>,
    #[serde(default)]
    pub tls: String,
    #[serde(default)]
    pub via: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub streams: Streams,
    #[serde(default)]
    pub armed: bool,
    #[serde(default)]
    pub armed_by: Option<String>,
    #[serde(default)]
    pub armed_at: Option<u64>,
    #[serde(default)]
    pub test: Option<TestResult>,
}

impl Stored {
    pub fn prefix(&self) -> &str {
        if self.prefix.is_empty() { DEFAULT_PREFIX } else { &self.prefix }
    }

    pub fn tls(&self) -> &str {
        if self.tls.is_empty() { "auto" } else { &self.tls }
    }

    pub fn configured(&self) -> bool {
        !self.url.trim().is_empty()
    }

    /// Address, route and certificate setting: what a kept secret is bound to (the same
    /// definition as a cluster's, `bridge::destination_of`).
    pub fn destination(&self) -> String {
        crate::bridge::destination_of(&self.url, Some(self.via.as_str()).filter(|v| !v.is_empty()), Some(self.tls()))
    }

    /// The settings a test ran against, as one opaque string: change any of them and the test
    /// no longer counts. Holds no secret: the sealed form is hashed with the rest.
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for part in [self.url.as_str(), self.via.as_str(), self.tls(), self.prefix(), self.user.as_str(),
                     self.sealed.as_deref().unwrap_or(""), self.auth.as_str()] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        hex::encode(h.finalize())
    }

    /// The secret no longer opens here: the address, route or certificate setting, or the kind
    /// of credential, changed since it was typed.
    pub fn secret_stale(&self) -> bool {
        self.sealed.is_some() && (self.sealed_for != self.destination() || self.sealed_auth != Some(self.auth))
    }

    pub fn test_current(&self) -> bool {
        self.test.as_ref().is_some_and(|t| t.ok && t.fingerprint == self.fingerprint())
    }

    /// Where the index template was verified: the store and the prefix together. A new
    /// address with the same prefix is another store, whose template is not known to be there.
    pub fn template_key(&self) -> String {
        format!("{}|{}", self.destination(), self.prefix())
    }
}

/// The associated data a store secret is sealed under: moved to another destination, or read
/// as another kind of credential, it does not open.
pub fn seal_aad(destination: &str, kind: AuthKind) -> String {
    format!("history-store|{}|{destination}", kind.as_str())
}

/// Why *Write history* cannot be turned on for these settings, or `None`. Pure: it is asked
/// inside the settings lock, so the decision and the switch are one step.
pub fn arm_blocked(s: &Stored, permitted: bool) -> Option<String> {
    if !permitted {
        return Some(PERMIT_HINT.into());
    }
    if !s.configured() {
        return Some("set the store's URL and save".into());
    }
    match &s.test {
        None => Some("run Test connection first".into()),
        Some(t) if !t.ok => Some("the last Test connection failed: fix it and test again".into()),
        Some(_) if !s.test_current() => Some("the settings changed since the last Test connection: test again".into()),
        Some(_) => None,
    }
}

/// What an admin sent in `HISTORY_STORE_SET`, checked. `Err` names what is wrong.
pub struct Incoming {
    pub url: String,
    pub auth: AuthKind,
    pub user: String,
    /// A new password or API key; `None` keeps the one held.
    pub secret: Option<String>,
    pub tls: String,
    pub via: String,
    pub prefix: String,
    pub streams: Streams,
}

pub fn parse_incoming(v: &Value) -> Result<Incoming, String> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let auth = match s("auth").as_str() {
        "" | "basic" => AuthKind::Basic,
        "apiKey" => AuthKind::ApiKey,
        "none" => AuthKind::None,
        other => return Err(format!("auth {other:?} is not basic, apiKey or none")),
    };
    let url = s("url").trim_end_matches('/').to_string();
    if !url.is_empty() {
        let u = reqwest::Url::parse(&url).map_err(|e| format!("the URL does not parse: {e}"))?;
        if u.scheme() != "http" && u.scheme() != "https" {
            return Err("the URL must start with http:// or https://".into());
        }
        if !u.username().is_empty() || u.password().is_some() {
            return Err("put the credential in the user and password fields, not in the URL".into());
        }
        if u.host_str().is_none_or(str::is_empty) || u.query().is_some() || u.fragment().is_some() || u.path() != "/" {
            return Err("the URL is the store's address only: scheme, host and port".into());
        }
        if u.scheme() == "http" && auth != AuthKind::None {
            return Err("a credential is sent to the store only over https://: use an https:// URL, or no authentication".into());
        }
    }
    let tls = match s("tls").as_str() {
        "" | "auto" => "auto",
        "system" => "system",
        "insecure" => "insecure",
        other => return Err(format!("tls {other:?} is not auto, system or insecure")),
    }.to_string();
    let prefix = match s("prefix") {
        p if p.is_empty() => DEFAULT_PREFIX.to_string(),
        p if history_prefix_ok(&p) => p,
        p => return Err(match history_prefix_reserved(&p) {
            Some(f) => format!("the prefix {p:?} would name {f}… indices, which belong to something else on a store: choose another"),
            None => format!("the prefix {p:?} must be lower case letters, digits, '.', '_' or '-', not starting with '-', '_', '+' or '.'"),
        }),
    };
    let user = s("user");
    if user.chars().any(char::is_control) || user.len() > 256 {
        return Err("the user name is too long or has control characters".into());
    }
    // The page shows `*` for a secret that is set; sending it back, or nothing, keeps it.
    let secret_key = if auth == AuthKind::ApiKey { "apiKey" } else { "password" };
    let secret = v.get(secret_key).and_then(Value::as_str).filter(|p| !p.is_empty() && *p != "*").map(String::from);
    if secret.as_deref().is_some_and(|p| p.chars().any(char::is_control) || p.len() > crate::cluster_secrets::MAX_PASSWORD) {
        return Err("the password or API key is too long or has control characters".into());
    }
    let streams = v.get("streams").cloned().map(serde_json::from_value::<Streams>).transpose()
        .map_err(|e| format!("streams: {e}"))?.unwrap_or_default();
    Ok(Incoming { url, auth, user, secret, tls, via: s("via"), prefix, streams })
}

/* -------------------------------------------- state -------------------------------------------- */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backfill {
    pub running: bool,
    /// Month files done, of all of them.
    pub done: u64,
    pub total: u64,
    pub docs: u64,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub last_success_at: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_at: Option<u64>,
    pub docs_written: u64,
    /// Why the last tick wrote nothing, when a gate was closed. Not an error.
    pub last_skipped: Option<String>,
    /// Documents dropped because the queue was full (the oldest days first).
    pub dropped: u64,
    /// Documents the guard refused to send (dropped, never retried).
    pub refused: u64,
    /// Documents the store rejected as malformed `REJECT_TRIES` times, then given up.
    pub rejected: u64,
    /// When the index template was last verified on this store under this prefix.
    pub template_at: Option<u64>,
}

/// One document waiting: the day it is about (its index is worked out from the prefix in force
/// when it is sent, so a prefix change never strands it) and its body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    pub day: String,
    pub doc: Value,
    /// Times the store rejected it as malformed.
    #[serde(default)]
    pub tries: u32,
}

/// `(stream, cluster, _id)`: the order bulks are cut in, and the key a rewrite replaces.
pub type QKey = (String, String, String);

pub struct HistoryStore {
    path: Option<PathBuf>,
    queue_path: Option<PathBuf>,
    pub(crate) stored: RwLock<Stored>,
    pub(crate) status: Mutex<Status>,
    pub(crate) queue: Mutex<BTreeMap<QKey, Queued>>,
    /// The queue changed since it was last written; the tick writes it, off the runtime.
    queue_dirty: AtomicBool,
    pub(crate) backfill: Mutex<Option<Backfill>>,
    ticking: AtomicBool,
    /// One test at a time.
    testing: tokio::sync::Mutex<()>,
    /// `Stored::template_key` of the store the template was verified on, in this process.
    template_ok: Mutex<Option<String>>,
    /// The store did not answer a read: `(destination, until, why)`.
    unreachable: Mutex<Option<(String, u64, String)>>,
}

impl HistoryStore {
    /// Hosted keeps its settings and queue in the data directory; every other edition has
    /// none and answers "hosted only". A start whose config.txt no longer permits writes
    /// disarms: putting the key back needs a new decision by an admin.
    pub fn open(data_dir: Option<&std::path::Path>, hosted: bool) -> HistoryStore {
        let dir = data_dir.filter(|_| hosted);
        let path = dir.map(|d| d.join(FILE));
        let queue_path = dir.map(|d| d.join(QUEUE_FILE));
        let stored: Stored = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let queue: Vec<(QKey, Queued)> = queue_path.as_ref().and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let h = HistoryStore {
            path, queue_path,
            stored: RwLock::new(stored),
            status: Mutex::new(Status::default()),
            queue: Mutex::new(queue.into_iter().collect()),
            queue_dirty: AtomicBool::new(false),
            backfill: Mutex::new(None),
            ticking: AtomicBool::new(false),
            testing: tokio::sync::Mutex::new(()),
            template_ok: Mutex::new(None),
            unreachable: Mutex::new(None),
        };
        if h.stored.read().armed && !permitted() {
            let r = h.update(|s| {
                s.armed = false;
                s.armed_by = None;
                s.armed_at = None;
                Ok(())
            });
            tracing::warn!(target: "audit", saved = r.is_ok(),
                           "history store: disarmed at start, config.txt does not set HISTORY_STORE_WRITES=true");
        }
        h
    }

    pub fn supported(&self) -> bool {
        self.path.is_some()
    }

    fn save(&self, s: &Stored) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
        crate::volume::store::write_atomic(p, &bytes)
    }

    /// Change the settings under the lock and write them; the change is kept only when `f`
    /// agreed to it and the file was written. Decisions about the settings are made in `f`,
    /// inside the lock, so nothing can change them between the check and the change.
    pub(crate) fn update(&self, f: impl FnOnce(&mut Stored) -> Result<(), String>) -> Result<Stored, String> {
        let mut g = self.stored.write();
        let mut next = g.clone();
        f(&mut next)?;
        next.version = 1;
        self.save(&next)?;
        *g = next.clone();
        Ok(next)
    }

    /// The queue as a file, when it changed since it was last written.
    fn queue_snapshot(&self) -> Option<(PathBuf, Vec<u8>)> {
        let p = self.queue_path.clone()?;
        if !self.queue_dirty.swap(false, Ordering::SeqCst) {
            return None;
        }
        let snapshot: Vec<(QKey, Queued)> = self.queue.lock().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        serde_json::to_vec(&snapshot).ok().map(|b| (p, b))
    }

    /// Write the queue file, off the async runtime, when it changed.
    pub(crate) async fn flush_queue(&self) {
        let Some((p, bytes)) = self.queue_snapshot() else { return };
        let res = tokio::task::spawn_blocking(move || crate::volume::store::write_atomic(&p, &bytes)).await;
        if !matches!(res, Ok(Ok(()))) {
            self.queue_dirty.store(true, Ordering::SeqCst);
            tracing::warn!("history store: the queue could not be written; tried again next tick");
        }
    }

    /// Put documents in the queue (a rewrite of a waiting one replaces it). Past `QUEUE_MAX`
    /// the oldest days go, counted. A document whose day is not a day is not queued.
    pub fn enqueue(&self, items: Vec<(QKey, Queued)>) {
        let items: Vec<(QKey, Queued)> = items.into_iter().filter(|(_, q)| parse_day(&q.day).is_some()).collect();
        if items.is_empty() {
            return;
        }
        {
            let mut q = self.queue.lock();
            for (k, v) in items {
                q.insert(k, v);
            }
            let over = q.len().saturating_sub(QUEUE_MAX);
            if over > 0 {
                let mut by_age: Vec<(String, QKey)> = q.iter().map(|(k, v)| (v.day.clone(), k.clone())).collect();
                by_age.sort();
                for (_, k) in by_age.into_iter().take(over) {
                    q.remove(&k);
                }
                self.status.lock().dropped += over as u64;
            }
        }
        self.queue_dirty.store(true, Ordering::SeqCst);
    }

    /// Forget what is waiting for a stream that was turned off.
    pub fn drop_stream(&self, stream: &str) -> usize {
        let mut q = self.queue.lock();
        let before = q.len();
        q.retain(|k, _| k.0 != stream);
        let gone = before - q.len();
        if gone > 0 {
            self.queue_dirty.store(true, Ordering::SeqCst);
        }
        gone
    }

    pub fn queue_len(&self) -> usize {
        self.queue.lock().len()
    }
}

/// Whether config.txt permits writes to the store: the first gate.
pub fn permitted() -> bool {
    crate::settings::get().flag(PERMIT_KEY) == Some(true)
}

/* ------------------------------------------ documents ------------------------------------------ */

/// `<prefix>-<stream>-YYYY.MM` for a `YYYY-MM-DD` day.
pub fn index_for_day(prefix: &str, stream: &str, day: &str) -> Option<String> {
    let d = parse_day(day)?;
    Some(format!("{prefix}-{stream}-{}", month_key(d).replace('-', ".")))
}

/// `cluster|day`, the volume and capacity streams' `_id`.
pub fn day_id(cluster: &str, day: &str) -> String {
    format!("{cluster}|{day}")
}

fn source_doc(s: &SourceTotals) -> Value {
    let (pri, total) = s.sizes();
    json!({ "indices": s.indices, "priBytes": pri, "totalBytes": total, "docs": s.docs,
            "eventBytes": s.event_bytes, "subBytes": s.sub_bytes, "unmeasuredSizeIndices": s.unmeasured_size_indices })
}

/// One day of the daily record as the volume stream keeps it. Sizes are the whole-day figure
/// (`Day::sizes`): `null` while the size is not measured, so a reader of the store directly
/// never takes the dated part for the day.
pub fn volume_doc(cluster: &str, name: &str, d: &Day, now_ms: u64) -> Value {
    let (pri, total) = d.sizes();
    let sources: Map<String, Value> = d.sources.iter().map(|(k, s)| (k.clone(), source_doc(s))).collect();
    json!({
        "clusterId": cluster, "clusterName": name, "day": d.day, "final": d.is_final, "live": d.live,
        "indices": d.indices, "docs": d.docs, "eventBytes": d.event_bytes, "subBytes": d.sub_bytes,
        "priBytes": pri, "totalBytes": total, "unmeasuredSizeIndices": d.unmeasured_size_indices,
        "sources": sources, "error": d.error, "aggregatedAt": d.aggregated_at, "totalsAt": d.totals_at,
        "writtenAt": now_ms,
    })
}

/// A volume document read back as a day of the record (no top values: the stream does not
/// keep them). `None` for a document that is not one.
pub fn day_from_doc(v: &Value) -> Option<(String, Day)> {
    let cluster = v.get("clusterId")?.as_str()?.to_string();
    let day = v.get("day")?.as_str()?;
    parse_day(day)?;
    let u = |k: &str| v.get(k).and_then(Value::as_u64);
    let sources = v.get("sources").and_then(Value::as_object).map(|m| {
        m.iter().filter_map(|(k, s)| serde_json::from_value::<SourceTotals>(s.clone()).ok().map(|t| (k.clone(), t))).collect()
    }).unwrap_or_default();
    Some((cluster, Day {
        day: day.to_string(),
        is_final: v.get("final").and_then(Value::as_bool).unwrap_or(false),
        live: v.get("live").and_then(Value::as_bool).unwrap_or(false),
        aggregated_at: v.get("aggregatedAt").and_then(Value::as_i64),
        totals_at: v.get("totalsAt").and_then(Value::as_i64).unwrap_or(0),
        indices: u("indices").unwrap_or(0),
        pri_bytes: u("priBytes"),
        total_bytes: u("totalBytes"),
        docs: u("docs"),
        event_bytes: u("eventBytes"),
        sub_bytes: u("subBytes"),
        unmeasured_size_indices: u("unmeasuredSizeIndices").unwrap_or(0),
        sources,
        fields: BTreeMap::new(),
        error: v.get("error").and_then(Value::as_str).map(String::from),
    }))
}

/// The roles `_cat/nodes` abbreviates that hold data: data, data_content, data_hot,
/// data_warm, data_cold, data_frozen (docs/REPORTS.md "Disk means data nodes").
pub fn is_data_role(roles: &str) -> bool {
    roles.chars().any(|c| matches!(c, 'd' | 's' | 'h' | 'w' | 'c' | 'f'))
}

fn num(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Disk of the data nodes only: `(total, used, free, nodes)`, each figure from `_cat/allocation`
/// for the node when it lists it, else from `_cat/nodes`. A data node whose figure cannot be
/// read makes that sum `None` — never a sum that quietly left a node out.
pub fn data_node_disk(nodes: &Value, alloc: Option<&Value>) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let Some(rows) = nodes.as_array() else { return (None, None, None, None) };
    let by_node: BTreeMap<&str, &Value> = alloc.and_then(Value::as_array).into_iter().flatten()
        .filter_map(|r| Some((r.get("node")?.as_str()?, r))).collect();
    let (mut total, mut used, mut free, mut n) = (Some(0u64), Some(0u64), Some(0u64), 0u64);
    for r in rows {
        if !r.get("node.role").and_then(Value::as_str).is_some_and(is_data_role) {
            continue;
        }
        n += 1;
        let a = r.get("name").and_then(Value::as_str).and_then(|name| by_node.get(name).copied());
        let pick = |k: &str| a.and_then(|a| num(a.get(k))).or_else(|| num(r.get(k)));
        total = total.zip(pick("disk.total")).map(|(a, b)| a + b);
        used = used.zip(pick("disk.used")).map(|(a, b)| a + b);
        free = free.zip(pick("disk.avail")).map(|(a, b)| a + b);
    }
    if n == 0 {
        return (None, None, None, Some(0));
    }
    (total, used, free, Some(n))
}

/// What the capacity document is made of, gathered by the core.
pub struct CapacityInputs<'a> {
    pub cluster: &'a str,
    pub name: &'a str,
    pub day: NaiveDate,
    /// `_cat/nodes` and `_cat/allocation` rows from the fleet cache, when it holds them.
    pub nodes: Option<&'a Value>,
    pub alloc: Option<&'a Value>,
    pub nodes_fetched_at: Option<u64>,
    /// The oldest day of the daily record still `live` (its indices are there).
    pub oldest_live: Option<NaiveDate>,
    /// The cluster's entry in the config file: `liveRetention`, `snapshotRetention`,
    /// `backupCapacity` as a person typed them.
    pub entry: Option<&'a Value>,
    pub meta: Option<&'a crate::cluster_meta::Meta>,
    /// The record's last seven finished days: `(day, eventBytes)`.
    pub last7: Vec<(String, Option<u64>)>,
    pub now_ms: u64,
}

fn typed(entry: Option<&Value>, keys: &[&str]) -> Value {
    for k in keys {
        match entry.and_then(|e| e.get(*k)) {
            Some(Value::String(s)) if !s.trim().is_empty() => return json!(s.trim()),
            Some(Value::Number(n)) => return json!(n.to_string()),
            _ => {}
        }
    }
    Value::Null
}

/// The capacity stream's document: measurements and settings as typed, never a verdict.
pub fn capacity_doc(i: &CapacityInputs<'_>) -> Value {
    let (total, used, free, nodes) = i.nodes.map(|n| data_node_disk(n, i.alloc)).unwrap_or((None, None, None, None));
    let held = i.oldest_live.map(|d| (i.day - d).num_days().max(0));
    let ulm = i.meta.map(|m| m.ulm.bucket.trim()).filter(|b| !b.is_empty());
    json!({
        "clusterId": i.cluster, "clusterName": i.name, "day": day_key(i.day),
        "dataNodeDiskTotal": total, "dataNodeDiskUsed": used, "dataNodeDiskFree": free, "dataNodes": nodes,
        "dataNodeDiskAt": i.nodes_fetched_at,
        "liveRetentionHeldDays": held, "liveRetentionOldestDay": i.oldest_live.map(day_key),
        "liveRetentionPolicy": typed(i.entry, &["liveRetention", "live_retention"]),
        "snapshotRetention": typed(i.entry, &["snapshotRetention", "snapshot_retention"]),
        "backupCapacity": typed(i.entry, &["backupCapacity", "backup_capacity"]),
        // The core does not measure a repository's size (Elasticsearch does not report it);
        // null is "not measured", never 0.
        "repositoryBytes": Value::Null,
        "clusterType": i.meta.map(|m| m.kind.clone()).filter(|k| !k.is_empty()),
        "ulmBucket": ulm,
        "perDayEventBytes7d": i.last7.iter().map(|(d, b)| json!({ "day": d, "eventBytes": b })).collect::<Vec<_>>(),
        "writtenAt": i.now_ms,
    })
}

/// The index template: mappings only (no settings, so nothing about ILM — the store's
/// retention is its owner's). `dynamic: false` keeps a source name or a field of a later
/// release from growing the mapping; everything stays in `_source`.
pub fn template_body(prefix: &str) -> Value {
    let long = json!({ "type": "long" });
    let kw = json!({ "type": "keyword" });
    let day = json!({ "type": "date", "format": "yyyy-MM-dd" });
    let ms = json!({ "type": "date", "format": "epoch_millis" });
    let off = json!({ "type": "object", "enabled": false });
    let boolean = json!({ "type": "boolean" });
    let fields: &[(&str, &Value)] = &[
        // volume and capacity
        ("clusterId", &kw), ("clusterName", &kw), ("day", &day), ("writtenAt", &ms), ("final", &boolean), ("live", &boolean),
        ("indices", &long), ("docs", &long), ("eventBytes", &long), ("subBytes", &long), ("priBytes", &long), ("totalBytes", &long),
        ("unmeasuredSizeIndices", &long), ("sources", &off), ("error", &json!({ "type": "text" })), ("aggregatedAt", &ms), ("totalsAt", &ms),
        ("dataNodeDiskTotal", &long), ("dataNodeDiskUsed", &long), ("dataNodeDiskFree", &long), ("dataNodes", &long),
        ("dataNodeDiskAt", &ms), ("liveRetentionHeldDays", &long), ("liveRetentionOldestDay", &day),
        ("liveRetentionPolicy", &kw), ("snapshotRetention", &kw), ("backupCapacity", &kw), ("repositoryBytes", &long),
        ("clusterType", &kw), ("ulmBucket", &kw), ("perDayEventBytes7d", &off),
        // delay (the fields delay_sink.rs writes)
        ("@timestamp", &json!({ "type": "date" })), ("cluster", &kw), ("device", &kw),
        ("arrival_time", &ms), ("event_time", &ms), ("delay_minutes", &json!({ "type": "float" })),
    ];
    let properties: Map<String, Value> = fields.iter().map(|(k, v)| (k.to_string(), (*v).clone())).collect();
    json!({
        "index_patterns": [format!("{prefix}-*")],
        "priority": 200,
        "_meta": { "managedBy": "ElasticPro", "contract": "docs/HISTORY.md" },
        "template": { "mappings": { "dynamic": false, "properties": properties } },
    })
}

/// The privilege check's body.
pub fn privileges_body(prefix: &str) -> Value {
    json!({
        "cluster": ["manage_index_templates"],
        "index": [{ "names": [format!("{prefix}-*")], "privileges": ["create_doc", "create_index", "read"] }],
    })
}

/// The answer to `_has_privileges`, per privilege.
pub fn read_privileges(res: &Value, prefix: &str) -> Privileges {
    let idx = res.pointer("/index").and_then(|i| i.get(format!("{prefix}-*")));
    let p = |k: &str| idx.and_then(|i| i.get(k)).and_then(Value::as_bool);
    Privileges {
        create_doc: p("create_doc"),
        create_index: p("create_index"),
        read: p("read"),
        manage_index_templates: res.pointer("/cluster/manage_index_templates").and_then(Value::as_bool),
    }
}

/// An error answer that says the store runs without security, where every request is allowed
/// and there is nothing to check.
pub fn security_disabled(res: &Value) -> bool {
    let text = res.to_string().to_ascii_lowercase();
    text.contains("security must be explicitly enabled") || text.contains("security is not enabled")
        || text.contains("security is disabled")
}


/// NDJSON for queued documents, all `index` actions with their `_id`, each into the index its
/// stream and day make under `prefix` — the prefix in force now, not when it was queued.
pub fn bulk_body(prefix: &str, items: &[(&QKey, &Queued)]) -> String {
    let mut s = String::new();
    for (k, q) in items {
        let Some(index) = index_for_day(prefix, &k.0, &q.day) else { continue };
        s.push_str(&json!({ "index": { "_index": index, "_id": k.2 } }).to_string());
        s.push('\n');
        s.push_str(&q.doc.to_string());
        s.push('\n');
    }
    s
}

/// Cut queued documents into bulks: the volume stream one per cluster, the others one per
/// stream; each at most `BULK_MAX_DOCS` documents and `BULK_MAX_BYTES` bytes.
pub fn cut_bulks(q: &BTreeMap<QKey, Queued>, max_bulks: usize) -> Vec<Vec<QKey>> {
    let mut out: Vec<Vec<QKey>> = vec![];
    let mut cur: Vec<QKey> = vec![];
    let (mut bytes, mut group) = (0usize, None::<(String, String)>);
    for (k, v) in q {
        let g = (k.0.clone(), if k.0 == "volume" { k.1.clone() } else { String::new() });
        let size = v.doc.to_string().len() + k.0.len() + v.day.len() + k.2.len() + 80;
        if !cur.is_empty() && (group.as_ref() != Some(&g) || cur.len() >= BULK_MAX_DOCS || bytes + size > BULK_MAX_BYTES) {
            out.push(std::mem::take(&mut cur));
            bytes = 0;
            if out.len() >= max_bulks {
                return out;
            }
        }
        group = Some(g);
        bytes += size;
        cur.push(k.clone());
    }
    if !cur.is_empty() && out.len() < max_bulks {
        out.push(cur);
    }
    out
}

/// What the store did with one document of a bulk.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Taken,
    /// Not taken this time for a reason that may pass (overloaded, unavailable, no answer).
    Kept(String),
    /// Refused as malformed: offering it again will not change the answer.
    Rejected(String),
}

/// The error types that say the document itself is wrong.
const PERMANENT: &[&str] = &["mapper_parsing_exception", "document_parsing_exception", "illegal_argument_exception",
                             "strict_dynamic_mapping_exception", "invalid_index_name_exception", "parse_exception"];

/// Each item of a bulk answer, by position.
pub fn bulk_items(res: &Value, n: usize) -> Vec<Item> {
    let mut out = vec![Item::Kept("not in the answer".into()); n];
    let Some(items) = res.get("items").and_then(Value::as_array) else { return out };
    for (i, it) in items.iter().enumerate().take(n) {
        let Some(r) = it.get("index").or_else(|| it.get("create")) else { continue };
        let status = r.get("status").and_then(Value::as_u64).unwrap_or(0);
        out[i] = match r.get("error") {
            None if (200..300).contains(&status) || status == 0 => Item::Taken,
            None => Item::Kept(format!("status {status}")),
            Some(e) => {
                let kind = e.get("type").and_then(Value::as_str).unwrap_or("");
                let reason = format!("{kind}: {}", e.get("reason").and_then(Value::as_str).unwrap_or("rejected"));
                if PERMANENT.contains(&kind) || status == 400 { Item::Rejected(reason) } else { Item::Kept(reason) }
            }
        };
    }
    out
}

/// A bulk that did not come back at all: refused by the guard before a socket (`refused`), or
/// the store did not answer.
#[derive(Debug)]
pub struct BulkFailure {
    pub refused: bool,
    pub message: String,
}

/// What a store answer that did not come back fine says, as one line.
fn why(res: &Value) -> String {
    let base = res.get("message").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("request failed");
    match res.pointer("/json/error/reason").and_then(Value::as_str) {
        Some(r) => format!("{base}: {r}"),
        None => base.to_string(),
    }
}

fn ok(res: &Value) -> bool {
    res.get("ok").and_then(Value::as_bool) == Some(true)
}

fn now() -> u64 {
    crate::fleet::now_ms()
}

/* ------------------------------------------- read-back ------------------------------------------- */

/// What one read-back found, and how the page says so.
#[derive(Debug, Default)]
pub struct ReadBack {
    pub from: String,
    pub to: String,
    pub reachable: bool,
    pub message: Option<String>,
    /// The bound was reached: days on or before this one may not all have been read.
    pub truncated_before: Option<NaiveDate>,
    /// The store answered with no day and has no ElasticPro index template under the prefix:
    /// nothing was ever written there, which is not the same as "no days".
    pub template_missing: bool,
    pub days: BTreeMap<String, Vec<Day>>,
}

impl ReadBack {
    pub fn count(&self) -> usize {
        self.days.values().map(Vec::len).sum()
    }

    /// The reply's `history` object.
    pub fn json(&self) -> Value {
        let message = if !self.reachable {
            Some(format!("in the history store · not reachable{}", self.message.as_deref().map(|m| format!(": {m}")).unwrap_or_default()))
        } else {
            self.message.clone()
        };
        json!({ "asked": true, "from": self.from, "to": self.to, "reachable": self.reachable,
                "days": self.count(), "truncated": self.truncated_before.is_some(),
                "truncatedBefore": self.truncated_before.map(day_key),
                "templateMissing": self.template_missing, "message": message })
    }
}

/// One read-back page: the days of these clusters in `[from, to]`, newest first, unique by
/// `(day, clusterId)` so `search_after` pages through them. `light` leaves the per-source
/// figures out (the month views do not use them).
pub fn read_back_body(clusters: &[String], from: NaiveDate, to: NaiveDate, light: bool, after: Option<&Value>) -> Value {
    let mut b = json!({
        "size": READ_BACK_PAGE, "track_total_hits": true,
        "sort": [{ "day": { "order": "desc" } }, { "clusterId": { "order": "asc" } }],
        "query": { "bool": { "filter": [
            { "terms": { "clusterId": clusters } },
            { "range": { "day": { "gte": day_key(from), "lte": day_key(to), "format": "yyyy-MM-dd" } } },
        ] } },
    });
    if light {
        b["_source"] = json!({ "excludes": ["sources"] });
    }
    if let Some(a) = after {
        b["search_after"] = a.clone();
    }
    b
}

/// The first day the local record covers for a cluster: where the history store's days stop
/// being needed. The one definition the Daily and the Monthly views both use. `None` when it
/// keeps nothing.
pub fn oldest_local_day(store: &crate::volume::store::Store, cluster: &str) -> Option<NaiveDate> {
    for m in store.months(cluster) {
        if let Some(d) = store.read_month(cluster, &m).days.keys().filter_map(|k| parse_day(k)).min() {
            return Some(d);
        }
    }
    None
}

/// The days to ask the store for: from `from` to the day before the local record starts
/// (or `to`, when there is none), when that is a range at all. Inside the local record a day
/// without a record had no indices, which is an answer, not a gap.
pub fn missing_range(from: NaiveDate, to: NaiveDate, oldest_local: Option<NaiveDate>) -> Option<(NaiveDate, NaiveDate)> {
    let end = match oldest_local {
        Some(o) => (o - Duration::days(1)).min(to),
        None => to,
    };
    (from <= end).then_some((from, end))
}

/* --------------------------------------------- core --------------------------------------------- */

fn refused(message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": "refused", "message": message.into() })
}

impl Core {
    fn history_supported(&self) -> bool {
        self.edition().schedules() && self.history_store.supported()
    }

    /// The monitored cluster at the store's address, if there is one: the store is dedicated,
    /// and a monitored cluster is never written by this feature.
    fn history_store_is_a_cluster(&self, url: &str) -> Option<String> {
        let hk = crate::http::host_key(url);
        self.all_specs().into_iter().find(|c| crate::http::host_key(&c.url) == hk).map(|c| c.id)
    }

    /// Where the store's requests go and with what: the store's own address, route,
    /// certificate setting and credential. `Err` says why there is no such place.
    pub(crate) fn history_spec(&self) -> Result<ClusterSpec, String> {
        if !self.history_supported() {
            return Err("the history store is hosted only".into());
        }
        let s = self.history_store.stored.read().clone();
        if !s.configured() {
            return Err("the history store is not configured: set its URL in Config › History store".into());
        }
        if let Some(id) = self.history_store_is_a_cluster(&s.url) {
            return Err(format!("the history store's address is the monitored cluster {id:?}'s: the store must be a dedicated endpoint"));
        }
        if s.auth != AuthKind::None && s.url.starts_with("http://") {
            return Err("a credential is sent to the store only over https://".into());
        }
        let secret = match (&s.auth, &s.sealed) {
            (AuthKind::None, _) => None,
            (_, None) => return Err("the history store has no credential: type its password or API key in Config › History store".into()),
            (_, Some(_)) if s.secret_stale() => {
                return Err("the store's address, route, TLS or kind of credential changed since its credential was typed: type it again".into())
            }
            (_, Some(sealed)) => match self.cluster_secrets.open_own(&seal_aad(&s.destination(), s.auth), sealed) {
                Some(p) => Some(p),
                None => return Err("the history store's credential does not open with this server's key: type it again".into()),
            },
        };
        let auth_header = secret.map(|p| match s.auth {
            AuthKind::ApiKey => format!("ApiKey {p}"),
            _ => {
                use base64::Engine as _;
                format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{p}", s.user)))
            }
        });
        Ok(ClusterSpec {
            id: STORE_ID.into(),
            name: Some("history store".into()),
            url: s.url.clone(),
            // An empty header is "no credential" to the transport, as for a probe.
            auth_header: Some(auth_header.unwrap_or_default()),
            via: Some(s.via.clone()).filter(|v| !v.is_empty()),
            tls: Some(s.tls().to_string()),
            ..ClusterSpec::default()
        })
    }

    /// Both gates, and what the store needs to be written to. `Err` names the one that is
    /// closed, as an admin reads it.
    pub(crate) fn history_writes_open(&self) -> Result<(), String> {
        if !self.history_supported() {
            return Err("the history store is hosted only".into());
        }
        if !permitted() {
            return Err(format!("config.txt does not permit writes to the history store: {PERMIT_HINT}"));
        }
        let s = self.history_store.stored.read();
        if !s.armed {
            return Err("Write history is off: an admin turns it on in Config › History store".into());
        }
        if !s.test_current() {
            return Err("the settings changed since the last passing Test connection: test again".into());
        }
        Ok(())
    }

    /// Right before a store request leaves, after it waited for its slot: still the same
    /// store, address, route, certificate setting, credential and prefix as when it was
    /// built, and the permission it may have now. `Err` when anything moved: not sent.
    pub(crate) fn history_recheck(&self, req: &EsRequest, url: &str, auth: Option<&str>, via: Option<&str>,
                                  tls: crate::tls::TlsMode) -> Result<Writes, String> {
        let spec = self.history_spec()?;
        let same = spec.url.trim_end_matches('/') == url.trim_end_matches('/')
            && spec.auth_header.as_deref() == auth
            && spec.via.as_deref() == via
            && crate::tls::TlsMode::parse(spec.tls.as_deref()) == tls
            && req.history_prefix.as_deref() == Some(self.history_store.stored.read().prefix());
        if !same {
            return Err("the history store's settings changed while this request waited for its turn: it was not sent".into());
        }
        let open = self.history_writes_open();
        // A write whose gates closed while it waited is not a write the guard should judge as
        // a read: it is simply not sent, and whatever it carried stays queued.
        let wants_write = req.method.trim().eq_ignore_ascii_case("PUT") || req.path.split('?').next() == Some("/_bulk");
        if let (true, Err(e)) = (wants_write, &open) {
            return Err(format!("{e}: this write waited for its turn and was not sent"));
        }
        Ok(if open.is_ok() { Writes::HistoryWrite } else { Writes::HistoryRead })
    }

    /// A write (or the test's reads) to the store: the core's own, in the background class.
    /// `es_req` sends it to the store whatever else it says.
    pub(crate) fn history_req(&self, method: &str, path: String, body: Option<String>, timeout_ms: u64) -> EsRequest {
        EsRequest {
            cluster_id: STORE_ID.into(),
            method: method.into(),
            path,
            body,
            timeout_ms: Some(timeout_ms),
            origin: Some(ORIGIN.into()),
            class: crate::gate::Class::Background,
            history_prefix: Some(self.history_store.stored.read().prefix().to_string()),
            ..EsRequest::default()
        }
    }

    /// A read a person is waiting for (a page's read-back, `HISTORY_QUERY`): the interactive
    /// class, so it waits for a slot no longer than a person's request does, and a short timeout.
    fn history_read_req(&self, path: String, body: Value) -> EsRequest {
        let mut r = self.history_req("POST", path, Some(body.to_string()), 8_000);
        r.class = crate::gate::Class::Interactive;
        r
    }

    /// What `HISTORY_STORE_GET` answers: the settings without any secret, the gates, the last
    /// test, the status.
    async fn history_view(&self) -> Value {
        let s = self.history_store.stored.read().clone();
        let st = self.history_store.status.lock().clone();
        let backfill = self.history_store.backfill.lock().clone();
        let mut jump: Vec<String> = self.tunnels.read().await.keys().cloned().collect();
        jump.sort();
        let test = s.test.as_ref().map(|t| {
            let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
            if let Some(o) = v.as_object_mut() {
                o.remove("fingerprint");
                o.insert("current".into(), json!(t.fingerprint == s.fingerprint()));
            }
            v
        });
        let template_ok = self.history_store.template_ok.lock().as_deref() == Some(s.template_key().as_str());
        json!({
            "ok": true, "supported": true,
            "settings": {
                "url": s.url, "auth": s.auth, "user": s.user,
                "passwordSet": s.sealed.is_some() && !s.secret_stale(), "passwordStale": s.secret_stale(),
                "tls": s.tls(), "via": s.via, "prefix": s.prefix(), "streams": s.streams,
            },
            "armed": s.armed, "armedBy": s.armed_by, "armedAt": s.armed_at,
            "permitted": permitted(), "permitHint": (!permitted()).then_some(PERMIT_HINT),
            "test": test,
            "armBlocked": if self.history_supported() { arm_blocked(&s, permitted()) } else { Some("the history store is hosted only".into()) },
            "writing": self.history_writes_open().err(),
            "status": {
                "lastSuccessAt": st.last_success_at, "lastError": st.last_error, "lastErrorAt": st.last_error_at,
                "docsWritten": st.docs_written, "queue": self.history_store.queue_len(), "dropped": st.dropped,
                "refused": st.refused, "rejected": st.rejected, "lastSkipped": st.last_skipped,
                "templateAt": st.template_at.filter(|_| template_ok),
                "backfill": backfill,
            },
            "jumpHosts": jump,
        })
    }

    /// `HISTORY_STORE_GET` / `_SET` / `_TEST` / `_ARM` / `_BACKFILL`: admin (auth.rs); the ones
    /// that change anything are fleet-wide, so a limited admin is refused.
    pub(crate) async fn history_store_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if !self.history_supported() {
            return json!({ "ok": false, "supported": false,
                           "message": "the history store is hosted only: it is written by the server, which is the one edition still running when nobody is looking" });
        }
        let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "admin".into());
        if t != "HISTORY_STORE_GET" && caller.is_some_and(Caller::limited) {
            return json!({ "ok": false, "kind": "forbidden",
                           "message": "the history store is fleet-wide: an admin limited to some clusters cannot change it" });
        }
        match t {
            "HISTORY_STORE_GET" => self.history_view().await,
            "HISTORY_STORE_SET" => self.history_set(msg, &by).await,
            "HISTORY_STORE_TEST" => self.history_test(&by).await,
            "HISTORY_STORE_ARM" => self.history_arm(msg, &by).await,
            "HISTORY_STORE_BACKFILL" => self.history_backfill_start(&by).await,
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("Unknown message type {t:?}") }),
        }
    }

    async fn history_set(&self, msg: &Value, by: &str) -> Value {
        let incoming = match parse_incoming(msg.get("settings").unwrap_or(&Value::Null)) {
            Ok(i) => i,
            Err(e) => return json!({ "ok": false, "kind": "bad_request", "message": e }),
        };
        if !incoming.url.is_empty() {
            if let Some(id) = self.history_store_is_a_cluster(&incoming.url) {
                return json!({ "ok": false, "kind": "bad_request",
                               "message": format!("that address is the monitored cluster {id:?}'s: the history store is a dedicated endpoint, never a monitored cluster") });
            }
        }
        let mut sealed_now: Option<(String, String)> = None;
        if let Some(secret) = &incoming.secret {
            let probe = Stored { url: incoming.url.clone(), via: incoming.via.clone(), tls: incoming.tls.clone(), ..Stored::default() };
            let dest = probe.destination();
            match self.cluster_secrets.seal_own(&seal_aad(&dest, incoming.auth), secret) {
                Ok(s) => sealed_now = Some((s, dest)),
                Err(e) => return json!({ "ok": false, "kind": "bad_request", "message": format!("the credential cannot be kept: {e}") }),
            }
        }
        let res = self.history_store.update(|s| {
            let before = s.fingerprint();
            s.url = incoming.url;
            s.auth = incoming.auth;
            s.user = if incoming.auth == AuthKind::Basic { incoming.user } else { String::new() };
            s.tls = incoming.tls;
            s.via = incoming.via;
            s.prefix = incoming.prefix;
            s.streams = incoming.streams;
            if let Some((sealed, dest)) = sealed_now {
                s.sealed = Some(sealed);
                s.sealed_for = dest;
                s.sealed_auth = Some(s.auth);
            }
            if s.auth == AuthKind::None {
                s.sealed = None;
                s.sealed_for.clear();
                s.sealed_auth = None;
            }
            // Other settings are not what the last test passed on, nor what arming agreed to:
            // the switch goes off and the next write waits for a new test and a new decision.
            if s.fingerprint() != before && s.armed {
                s.armed = false;
                s.armed_by = None;
                s.armed_at = None;
            }
            Ok(())
        });
        match res {
            Ok(s) => {
                // What waits for a stream that is now off is not sent later.
                let mut dropped = 0;
                for stream in ["volume", "capacity"] {
                    if !s.streams.on(stream) {
                        dropped += self.history_store.drop_stream(stream);
                    }
                }
                tracing::info!(target: "audit", user = %by, url = %s.url, prefix = %s.prefix(), auth = s.auth.as_str(),
                               streams = ?s.streams, armed = s.armed, dropped, "history store configured");
                self.history_view().await
            }
            Err(e) => json!({ "ok": false, "message": format!("could not save: {e}") }),
        }
    }

    async fn history_test(self: &Arc<Self>, by: &str) -> Value {
        let _one = self.history_store.testing.lock().await;
        // The settings the test runs on. Every request it sends is checked against the
        // settings at the moment it leaves (`history_recheck`), and the result is kept only if
        // the settings are still these when it ends.
        let s = self.history_store.stored.read().clone();
        let prefix = s.prefix().to_string();
        let mut t = TestResult { at: now(), by: by.into(), fingerprint: s.fingerprint(), ..TestResult::default() };
        let mut extra = Map::new();
        if let Err(e) = self.history_spec() {
            t.message = Some(e);
        } else {
            let root = self.es_req(self.history_req("GET", "/".into(), None, 15_000)).await;
            if !ok(&root) {
                t.message = Some(format!("GET /: {}", why(&root)));
                // What the page acts on (trust a certificate, a jump host's key).
                for k in ["kind", "cert", "pinned", "hostKey", "help"] {
                    if let Some(v) = root.get(k) {
                        extra.insert(k.into(), v.clone());
                    }
                }
            } else {
                t.version = root.pointer("/json/version/number").and_then(Value::as_str).map(String::from);
                t.cluster_name = root.pointer("/json/cluster_name").and_then(Value::as_str).map(String::from);
                let p = self.es_req(self.history_req("POST", "/_security/user/_has_privileges".into(),
                                                     Some(privileges_body(&prefix).to_string()), 15_000)).await;
                if ok(&p) {
                    t.security_enabled = Some(true);
                    t.privileges = read_privileges(p.get("json").unwrap_or(&Value::Null), &prefix);
                    let pv = &t.privileges;
                    let all = [pv.create_doc, pv.create_index, pv.read, pv.manage_index_templates];
                    t.ok = all.iter().all(|x| *x == Some(true));
                    if !t.ok {
                        let missing: Vec<&str> = ["create_doc", "create_index", "read", "manage_index_templates"].iter().zip(all)
                            .filter(|(_, v)| *v != Some(true)).map(|(n, _)| *n).collect();
                        t.message = Some(format!("the credential lacks {} on {prefix}-*", missing.join(", ")));
                    }
                } else if security_disabled(&p) {
                    t.security_enabled = Some(false);
                    t.ok = true;
                    t.message = Some("security is not enabled on the store: every request is allowed, so no privilege was checked".into());
                } else {
                    t.message = Some(format!("the privilege check: {}", why(&p)));
                }
            }
        }
        let res = self.history_store.update(|st| {
            if st.fingerprint() != t.fingerprint {
                return Err("the settings changed while the test ran: test again".into());
            }
            st.test = Some(t.clone());
            Ok(())
        });
        let passed = t.ok && res.is_ok();
        tracing::info!(target: "audit", user = %by, ok = passed, message = t.message.as_deref().unwrap_or(""), "history store tested");
        let mut out = self.history_view().await;
        out["ok"] = json!(passed);
        if let Err(e) = res {
            out["message"] = json!(e);
        } else if !passed {
            out["message"] = json!(t.message.clone().unwrap_or_else(|| "the test failed".into()));
        }
        if let Some(o) = out.as_object_mut() {
            o.extend(extra);
        }
        out
    }

    async fn history_arm(&self, msg: &Value, by: &str) -> Value {
        let on = msg.get("on").and_then(Value::as_bool).unwrap_or(false);
        let at = now();
        let permit = permitted();
        // The check and the switch in one step, under the settings lock.
        let res = self.history_store.update(|s| {
            if on {
                if let Some(why) = arm_blocked(s, permit) {
                    return Err(format!("Write history cannot be turned on: {why}"));
                }
            }
            s.armed = on;
            s.armed_by = on.then(|| by.to_string());
            s.armed_at = on.then_some(at);
            Ok(())
        });
        if let Err(e) = res {
            return refused(e);
        }
        tracing::info!(target: "audit", user = %by, armed = on, "history store write switch");
        self.history_view().await
    }

    /* ---------------------------------------- the writer ---------------------------------------- */

    /// The writer's timer: once a minute, hosted only. Started by the bridge binary.
    pub fn start_history_store(self: &Arc<Self>) {
        if !self.history_supported() {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                core.history_tick().await;
            }
        });
        tracing::info!(target: "audit", "history store: timer started");
    }

    /// The index template, verified once per store and prefix in this process: created with
    /// `create=true`, so a template of the same name is never replaced; one that is already
    /// there is accepted only when it is ElasticPro's (`_meta.managedBy`, the same pattern).
    async fn history_ensure_template(self: &Arc<Self>) -> Result<(), String> {
        let (key, prefix) = {
            let s = self.history_store.stored.read();
            (s.template_key(), s.prefix().to_string())
        };
        if self.history_store.template_ok.lock().as_deref() == Some(key.as_str()) {
            return Ok(());
        }
        let name = template_name(&prefix);
        let res = self.es_req(self.history_req("PUT", format!("/_index_template/{name}?create=true"),
                                               Some(template_body(&prefix).to_string()), 30_000)).await;
        if !ok(&res) {
            let reason = why(&res);
            if !reason.contains("already exists") {
                return Err(format!("the index template: {reason}"));
            }
            let got = self.es_req(self.history_req("GET", format!("/_index_template/{name}"), None, 15_000)).await;
            if !ok(&got) {
                return Err(format!("the index template {name} exists and could not be read: {}", why(&got)));
            }
            let t = got.pointer("/json/index_templates/0/index_template").cloned().unwrap_or(Value::Null);
            let ours = t.pointer("/_meta/managedBy").and_then(Value::as_str) == Some("ElasticPro")
                && t.get("index_patterns") == Some(&json!([format!("{prefix}-*")]));
            if !ours {
                return Err(format!("an index template named {name} already exists on the store and is not ElasticPro's \
                                    (no _meta.managedBy ElasticPro for {prefix}-*): remove it or choose another prefix"));
            }
        }
        *self.history_store.template_ok.lock() = Some(key);
        self.history_store.status.lock().template_at = Some(now());
        tracing::info!(target: "audit", prefix = %prefix, "history store: index template verified");
        Ok(())
    }

    /// Send one bulk of queued documents to the store, under the prefix in force now.
    async fn history_send_bulk(self: &Arc<Self>, items: &[(&QKey, &Queued)]) -> Result<Vec<Item>, BulkFailure> {
        let prefix = self.history_store.stored.read().prefix().to_string();
        let res = self.es_req(self.history_req("POST", "/_bulk".into(), Some(bulk_body(&prefix, items)), 60_000)).await;
        if !ok(&res) {
            return Err(BulkFailure { refused: res.get("kind").and_then(Value::as_str) == Some("blocked_readonly"), message: why(&res) });
        }
        Ok(bulk_items(res.get("json").unwrap_or(&Value::Null), items.len()))
    }

    fn history_note_error(&self, e: &str) {
        let mut st = self.history_store.status.lock();
        st.last_error = Some(e.to_string());
        st.last_error_at = Some(now());
    }

    fn history_note_written(&self, n: u64) {
        if n == 0 {
            return;
        }
        let mut st = self.history_store.status.lock();
        st.docs_written += n;
        st.last_success_at = Some(now());
    }

    /// One tick: when both gates are open, the template, then the queue in bulks. A bulk the
    /// store did not answer stays queued and ends the tick; a bulk the guard refused is dropped
    /// and counted, and the tick goes on; a document the store rejected as malformed is offered
    /// `REJECT_TRIES` times, then given up and counted. The local record never waits.
    #[doc(hidden)]
    pub async fn history_tick(self: &Arc<Self>) -> Value {
        if self.history_store.ticking.swap(true, Ordering::SeqCst) {
            return json!({ "ok": false, "skipped": "a tick is already running" });
        }
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _done = Done(&self.history_store.ticking);
        let out = self.history_tick_inner().await;
        self.history_store.flush_queue().await;
        out
    }

    async fn history_tick_inner(self: &Arc<Self>) -> Value {
        if let Err(why) = self.history_writes_open() {
            self.history_store.status.lock().last_skipped = Some(why.clone());
            return json!({ "ok": false, "skipped": why });
        }
        self.history_store.status.lock().last_skipped = None;
        if self.history_store.queue_len() == 0 {
            return json!({ "ok": true, "written": 0 });
        }
        if let Err(e) = self.history_ensure_template().await {
            self.history_note_error(&e);
            return json!({ "ok": false, "error": e });
        }
        let bulks = cut_bulks(&self.history_store.queue.lock(), BULKS_PER_TICK);
        let (mut written, mut refused_n, mut rejected_n, mut error) = (0u64, 0u64, 0u64, None::<String>);
        for keys in bulks {
            // Disarmed while this tick was sending: stop at once.
            if let Err(why) = self.history_writes_open() {
                error = Some(why);
                break;
            }
            let items: Vec<(QKey, Queued)> = {
                let q = self.history_store.queue.lock();
                keys.iter().filter_map(|k| q.get(k).map(|v| (k.clone(), v.clone()))).collect()
            };
            if items.is_empty() {
                continue;
            }
            let refs: Vec<(&QKey, &Queued)> = items.iter().map(|(k, v)| (k, v)).collect();
            match self.history_send_bulk(&refs).await {
                Err(f) if f.refused => {
                    // The guard said no before a socket: sending it again would get the same
                    // answer. Dropped, counted, and the rest of the queue goes on.
                    let mut q = self.history_store.queue.lock();
                    for (k, sent) in &items {
                        if q.get(k) == Some(sent) {
                            q.remove(k);
                        }
                    }
                    refused_n += items.len() as u64;
                    error = Some(format!("{} documents refused and dropped: {}", items.len(), f.message));
                }
                Err(f) => {
                    error = Some(format!("bulk: {}; kept for the next tick", f.message));
                    break;
                }
                Ok(results) => {
                    let mut q = self.history_store.queue.lock();
                    for ((k, sent), item) in items.iter().zip(&results) {
                        // Not rewritten while it was on its way: what was sent is what is decided on.
                        if q.get(k) != Some(sent) {
                            continue;
                        }
                        match item {
                            Item::Taken => {
                                q.remove(k);
                                written += 1;
                            }
                            Item::Rejected(why) => {
                                let tries = sent.tries + 1;
                                if tries >= REJECT_TRIES {
                                    q.remove(k);
                                    rejected_n += 1;
                                    error = Some(format!("{} {}: given up after {tries} rejections: {why}", k.0, k.2));
                                } else if let Some(v) = q.get_mut(k) {
                                    v.tries = tries;
                                    error.get_or_insert_with(|| format!("{} {}: rejected ({why}); offered again next tick", k.0, k.2));
                                }
                            }
                            Item::Kept(why) => {
                                error.get_or_insert_with(|| format!("{} {}: not taken ({why}); kept for the next tick", k.0, k.2));
                            }
                        }
                    }
                    self.history_store.queue_dirty.store(true, Ordering::SeqCst);
                }
            }
        }
        self.history_note_written(written);
        {
            let mut st = self.history_store.status.lock();
            st.refused += refused_n;
            st.rejected += rejected_n;
        }
        match &error {
            Some(e) => self.history_note_error(e),
            None => self.history_store.status.lock().last_error = None,
        }
        if written > 0 || error.is_some() {
            tracing::info!(target: "audit", written, refused = refused_n, rejected = rejected_n, queue = self.history_store.queue_len(),
                           error = error.as_deref().unwrap_or(""), "history store: bulk written");
        }
        json!({ "ok": error.is_none(), "written": written, "refused": refused_n, "rejected": rejected_n,
                "queue": self.history_store.queue_len(), "error": error })
    }

    /* ------------------------------------------- streams ------------------------------------------- */

    fn history_stream_on(&self, stream: &str) -> bool {
        let s = self.history_store.stored.read();
        s.configured() && s.streams.on(stream)
    }

    fn cluster_name(&self, id: &str) -> String {
        self.spec_for(id).and_then(|s| s.name).unwrap_or_else(|| id.to_string())
    }

    /// After a volume collection: the days it changed go in the queue. Only while both gates
    /// are open — a closed gate is not a backlog that floods the store the moment it opens
    /// (*Copy existing history* is how the past gets there).
    pub(crate) fn history_volume_changed(&self, cluster: &str, days: &BTreeSet<String>) {
        if days.is_empty() || !self.history_stream_on("volume") || self.history_writes_open().is_err() {
            return;
        }
        let Some(store) = &self.volume.store else { return };
        let name = self.cluster_name(cluster);
        let at = now();
        let mut by_month: BTreeMap<String, Vec<&String>> = BTreeMap::new();
        for d in days {
            if let Some(date) = parse_day(d) {
                by_month.entry(month_key(date)).or_default().push(d);
            }
        }
        let mut items = vec![];
        for (m, ds) in by_month {
            let file = store.read_month(cluster, &m);
            for d in ds {
                let Some(day) = file.days.get(d) else { continue };
                items.push((("volume".into(), cluster.to_string(), day_id(cluster, d)),
                            Queued { day: d.clone(), doc: volume_doc(cluster, &name, day, at), tries: 0 }));
            }
        }
        self.history_store.enqueue(items);
    }

    /// After a cluster's scheduled daily run: its capacity document for today, once a day.
    pub(crate) async fn history_capacity_after_run(&self, cluster: &str) {
        if !self.history_stream_on("capacity") || self.history_writes_open().is_err() {
            return;
        }
        let today = utc_day(now() as i64);
        let raw = self.volume_config().await.ok().flatten();
        let entry = raw.as_ref().and_then(|r| r.get("clusters")).and_then(Value::as_array).and_then(|list| {
            let ids = crate::cluster_save::config_ids(list);
            ids.iter().position(|i| i == cluster).and_then(|p| list.get(p).cloned())
        });
        let (nodes, alloc, fetched_at) = {
            let st = self.fleet.state.lock();
            match st.entries.get(&(cluster.to_string(), crate::fleet::catalogue::Dataset::Nodes)) {
                Some(e) => {
                    let body = e.data.clone();
                    let pick = |k: &str| body.as_ref().and_then(|b| b.field(k)).filter(ok).and_then(|a| a.get("json").cloned());
                    (pick("nodes"), pick("alloc"), e.fetched_at)
                }
                None => (None, None, None),
            }
        };
        let (oldest_live, last7) = match &self.volume.store {
            Some(store) => {
                let mut oldest = None;
                for m in store.months(cluster) {
                    if let Some(d) = store.read_month(cluster, &m).days.values().filter(|d| d.live).filter_map(|d| parse_day(&d.day)).min() {
                        oldest = Some(d);
                        break;
                    }
                }
                let week = store.days_between(cluster, today - Duration::days(7), today - Duration::days(1));
                (oldest, week.into_iter().map(|d| (d.day.clone(), d.event_bytes)).collect())
            }
            None => (None, vec![]),
        };
        let meta = self.cluster_meta.get(cluster);
        let name = self.cluster_name(cluster);
        let doc = capacity_doc(&CapacityInputs {
            cluster, name: &name, day: today, nodes: nodes.as_ref(), alloc: alloc.as_ref(), nodes_fetched_at: fetched_at,
            oldest_live, entry: entry.as_ref(), meta: meta.as_ref(), last7, now_ms: now(),
        });
        let day = day_key(today);
        self.history_store.enqueue(vec![(("capacity".into(), cluster.to_string(), day_id(cluster, &day)), Queued { day, doc, tries: 0 })]);
    }

    /// The delay sink's destination when it is the history store: the index for this run's
    /// month. `Err` says which gate is closed.
    pub(crate) fn history_delay_index(&self, year: i64, month: i64) -> Result<String, String> {
        self.history_writes_open()?;
        if !self.history_stream_on("delay") {
            return Err("the history store's delay stream is off (Config › History store)".into());
        }
        let prefix = self.history_store.stored.read().prefix().to_string();
        Ok(format!("{prefix}-delay-{year:04}.{month:02}"))
    }

    /// The delay sink's bulk, to the store. Counted in the store's status like its own.
    pub(crate) async fn history_delay_bulk(self: &Arc<Self>, ndjson: String) -> Value {
        if let Err(e) = self.history_ensure_template().await {
            self.history_note_error(&e);
            return json!({ "ok": false, "kind": "history_store", "message": e });
        }
        let n = ndjson.lines().filter(|l| !l.trim().is_empty()).count() / 2;
        let res = self.es_req(self.history_req("POST", "/_bulk".into(), Some(ndjson), 60_000)).await;
        if ok(&res) {
            let items = bulk_items(res.get("json").unwrap_or(&Value::Null), n);
            self.history_note_written(items.iter().filter(|i| **i == Item::Taken).count() as u64);
            if let Some(Item::Rejected(w) | Item::Kept(w)) = items.iter().find(|i| **i != Item::Taken) {
                self.history_note_error(&format!("delay: {w}"));
            }
        } else {
            self.history_note_error(&format!("delay: {}", why(&res)));
        }
        res
    }

    /// `historyStore` for `DELAY_SINK_GET`: whether the history store could take the
    /// measurements now.
    pub(crate) fn history_for_delay(&self) -> Value {
        let s = self.history_store.stored.read();
        json!({ "configured": s.configured(), "armed": s.armed, "permitted": permitted(),
                "streamOn": s.streams.delay, "prefix": s.prefix() })
    }

    /* ------------------------------------------- backfill ------------------------------------------- */

    async fn history_backfill_start(self: &Arc<Self>, by: &str) -> Value {
        if let Err(why) = self.history_writes_open() {
            return refused(format!("Copy existing history needs writes to the store: {why}"));
        }
        if !self.history_stream_on("volume") {
            return refused("the volume stream is off: turn it on to copy the daily record");
        }
        if self.volume.store.is_none() {
            return refused("this core keeps no daily record to copy");
        }
        {
            let mut b = self.history_store.backfill.lock();
            if b.as_ref().is_some_and(|b| b.running) {
                return refused("a copy is already running");
            }
            *b = Some(Backfill { running: true, started_at: now(), ..Backfill::default() });
        }
        tracing::info!(target: "audit", user = %by, "history store: copying the existing daily record");
        let core = self.clone();
        tokio::spawn(async move { core.history_backfill_run().await });
        self.history_view().await
    }

    /// Every local month file of every cluster, in pages of at most `BULK_MAX_DOCS`. Stops at
    /// the first failure or when a gate closes, and says so.
    async fn history_backfill_run(self: Arc<Self>) {
        let Some(store) = &self.volume.store else { return };
        let mut work: Vec<(String, String)> = vec![];
        for e in std::fs::read_dir(store.root()).into_iter().flatten().flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let Some(id) = e.file_name().to_str().and_then(crate::fleet::store::unescape) else { continue };
            for m in store.months(&id) {
                work.push((id.clone(), m));
            }
        }
        if let Some(b) = self.history_store.backfill.lock().as_mut() {
            b.total = work.len() as u64;
        }
        let mut error: Option<String> = None;
        if let Err(e) = self.history_ensure_template().await {
            error = Some(e);
        }
        'files: for (cluster, m) in work.iter().filter(|_| error.is_none()) {
            let name = self.cluster_name(cluster);
            let at = now();
            let file = store.read_month(cluster, m);
            let items: Vec<(QKey, Queued)> = file.days.values().map(|d| {
                (("volume".to_string(), cluster.clone(), day_id(cluster, &d.day)),
                 Queued { day: d.day.clone(), doc: volume_doc(cluster, &name, d, at), tries: 0 })
            }).collect();
            for page in items.chunks(BULK_MAX_DOCS) {
                if let Err(why) = self.history_writes_open() {
                    error = Some(format!("stopped: {why}"));
                    break 'files;
                }
                let refs: Vec<(&QKey, &Queued)> = page.iter().map(|(k, q)| (k, q)).collect();
                match self.history_send_bulk(&refs).await {
                    Err(f) => {
                        error = Some(format!("{cluster} {m}: {}", f.message));
                        break 'files;
                    }
                    Ok(results) => {
                        let n = results.iter().filter(|i| **i == Item::Taken).count() as u64;
                        self.history_note_written(n);
                        if let Some(b) = self.history_store.backfill.lock().as_mut() {
                            b.docs += n;
                        }
                        if let Some(Item::Rejected(w) | Item::Kept(w)) = results.iter().find(|i| **i != Item::Taken) {
                            error = Some(format!("{cluster} {m}: {} of {} not taken: {w}", page.len() as u64 - n, page.len()));
                            break 'files;
                        }
                    }
                }
            }
            if let Some(b) = self.history_store.backfill.lock().as_mut() {
                b.done += 1;
            }
        }
        if let Some(e) = &error {
            self.history_note_error(&format!("Copy existing history: {e}"));
        }
        let mut b = self.history_store.backfill.lock();
        if let Some(b) = b.as_mut() {
            b.running = false;
            b.finished_at = Some(now());
            b.error = error.clone();
            tracing::info!(target: "audit", files = b.done, docs = b.docs, error = error.as_deref().unwrap_or(""), "history store: copy finished");
        }
    }

    /* ------------------------------------------- read-back ------------------------------------------- */

    /// The volume days of these clusters in `[from, to]` from the store: pages of
    /// `READ_BACK_PAGE` days, newest first, at most `READ_BACK_PAGES` of them; past the bound
    /// the answer says on or before which day it did not read everything. Interactive class
    /// (a person is waiting), and a store that did not answer is not asked again for
    /// `UNREACHABLE_FOR_MS`. `None` when there is no store to ask (not hosted, not configured).
    pub(crate) async fn history_read_volume(self: &Arc<Self>, clusters: &[String], from: NaiveDate, to: NaiveDate,
                                            light: bool) -> Option<ReadBack> {
        if clusters.is_empty() || !self.history_supported() || !self.history_store.stored.read().configured() {
            return None;
        }
        let (dest, prefix) = {
            let s = self.history_store.stored.read();
            (s.destination(), s.prefix().to_string())
        };
        let mut rb = ReadBack { from: day_key(from), to: day_key(to), ..ReadBack::default() };
        let at = now();
        if let Some((d, until, why)) = self.history_store.unreachable.lock().clone() {
            if d == dest && at < until {
                rb.message = Some(format!("{why} (asked again after {} s)", (until - at).div_ceil(1000)));
                return Some(rb);
            }
        }
        let path = format!("/{prefix}-volume-*/_search?ignore_unavailable=true&allow_no_indices=true");
        let mut after: Option<Value> = None;
        let mut read = 0u64;
        for page in 0..READ_BACK_PAGES {
            let res = self.es_req(self.history_read_req(path.clone(), read_back_body(clusters, from, to, light, after.as_ref()))).await;
            if !ok(&res) {
                let w = why(&res);
                if page == 0 {
                    *self.history_store.unreachable.lock() = Some((dest, at + UNREACHABLE_FOR_MS, w.clone()));
                    rb.message = Some(w);
                    return Some(rb);
                }
                // Part was read: what was not is said, not guessed.
                rb.truncated_before = rb.days.values().flatten().filter_map(|d| parse_day(&d.day)).min();
                rb.message = Some(format!("the store stopped answering after {read} days ({w}): days on or before {} may be missing",
                                          rb.truncated_before.map(day_key).unwrap_or_default()));
                return Some(rb);
            }
            rb.reachable = true;
            *self.history_store.unreachable.lock() = None;
            let hits = res.pointer("/json/hits/hits").and_then(Value::as_array).cloned().unwrap_or_default();
            let total = res.pointer("/json/hits/total/value").and_then(Value::as_u64).unwrap_or(hits.len() as u64);
            for h in &hits {
                if let Some((c, d)) = h.get("_source").and_then(day_from_doc) {
                    if clusters.contains(&c) {
                        rb.days.entry(c).or_default().push(d);
                    }
                }
            }
            read += hits.len() as u64;
            if hits.len() < READ_BACK_PAGE || read >= total {
                break;
            }
            after = hits.last().and_then(|h| h.get("sort")).cloned();
            if page + 1 == READ_BACK_PAGES || after.is_none() {
                let last = hits.last().and_then(|h| h.pointer("/_source/day")).and_then(Value::as_str).and_then(parse_day);
                rb.truncated_before = last;
                rb.message = Some(format!("{read} of {total} days read (the bound for one request): days on or before {} are not all shown",
                                          last.map(day_key).unwrap_or_default()));
            }
        }
        if rb.count() == 0 {
            // No day: never written, or written and nothing in range? Said apart.
            let got = self.es_req({
                let mut r = self.history_req("GET", format!("/_index_template/{}", template_name(&prefix)), None, 8_000);
                r.class = crate::gate::Class::Interactive;
                r
            }).await;
            if got.get("status").and_then(Value::as_u64) == Some(404) {
                rb.template_missing = true;
                rb.message = Some(format!("nothing has been written to this store yet: it has no ElasticPro index template for {prefix}-*"));
            }
        }
        Some(rb)
    }

    /// `HISTORY_QUERY {stream, clusterId, from?, to?}` (user; the gate keeps a scoped caller and
    /// a limited admin to the clusters they see): the store's documents for one cluster that
    /// exists, oldest first, bounded.
    pub(crate) async fn history_query(self: &Arc<Self>, msg: &Value) -> Value {
        if !self.history_supported() {
            return json!({ "ok": false, "supported": false, "message": "the history store is hosted only" });
        }
        if !self.history_store.stored.read().configured() {
            return json!({ "ok": false, "kind": "not_configured", "message": "no history store is configured" });
        }
        let stream = msg.get("stream").and_then(Value::as_str).unwrap_or("");
        if !["volume", "capacity", "delay"].contains(&stream) {
            return json!({ "ok": false, "kind": "bad_request", "message": "stream must be volume, capacity or delay" });
        }
        let Some(id) = msg.get("clusterId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return json!({ "ok": false, "kind": "bad_request", "message": "clusterId is required" });
        };
        if self.spec_for(id).is_none() {
            return json!({ "ok": false, "kind": "not_found", "message": format!("no cluster {id:?}") });
        }
        let today = utc_day(now() as i64);
        let day_arg = |k: &str| msg.get(k).and_then(Value::as_str).map(|s| parse_day(s).ok_or(s.to_string()));
        let to = match day_arg("to") {
            None => today,
            Some(Ok(d)) => d,
            Some(Err(s)) => return json!({ "ok": false, "kind": "bad_request", "message": format!("to {s:?} is not a YYYY-MM-DD day") }),
        };
        let from = match day_arg("from") {
            None => to - Duration::days(29),
            Some(Ok(d)) => d,
            Some(Err(s)) => return json!({ "ok": false, "kind": "bad_request", "message": format!("from {s:?} is not a YYYY-MM-DD day") }),
        };
        if from > to || (to - from).num_days() > 1200 {
            return json!({ "ok": false, "kind": "bad_request", "message": "from must be on or before to, and the period at most 1200 days" });
        }
        let (cluster_field, range) = if stream == "delay" {
            ("cluster", json!({ "@timestamp": { "gte": day_key(from), "lt": day_key(to + Duration::days(1)), "format": "yyyy-MM-dd" } }))
        } else {
            ("clusterId", json!({ "day": { "gte": day_key(from), "lte": day_key(to), "format": "yyyy-MM-dd" } }))
        };
        let sort_field = if stream == "delay" { "@timestamp" } else { "day" };
        let body = json!({
            "size": QUERY_MAX, "track_total_hits": true, "sort": [{ sort_field: { "order": "asc" } }],
            "query": { "bool": { "filter": [ { "term": { cluster_field: id } }, { "range": range } ] } },
        });
        let prefix = self.history_store.stored.read().prefix().to_string();
        let res = self.es_req(self.history_read_req(format!("/{prefix}-{stream}-*/_search?ignore_unavailable=true&allow_no_indices=true"), body)).await;
        if !ok(&res) {
            return json!({ "ok": false, "kind": "unreachable", "reachable": false,
                           "message": format!("in the history store · not reachable: {}", why(&res)) });
        }
        let docs: Vec<Value> = res.pointer("/json/hits/hits").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|h| h.get("_source").cloned()).collect();
        let total = res.pointer("/json/hits/total/value").and_then(Value::as_u64).unwrap_or(docs.len() as u64);
        json!({ "ok": true, "stream": stream, "clusterId": id, "from": day_key(from), "to": day_key(to),
                "total": total, "truncated": total > docs.len() as u64, "docs": docs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(d: &str) -> Day {
        Day { day: d.into(), live: true, is_final: true, indices: 3, pri_bytes: Some(100), total_bytes: Some(200),
              docs: Some(10), event_bytes: Some(50), sub_bytes: None, totals_at: 5, ..Day::default() }
    }

    fn q(day: &str) -> Queued {
        Queued { day: day.into(), doc: json!({ "day": day }), tries: 0 }
    }

    #[test]
    fn ids_and_indices_are_deterministic() {
        assert_eq!(day_id("prod", "2026-11-03"), "prod|2026-11-03");
        assert_eq!(index_for_day("elasticpro-history", "volume", "2026-11-03").as_deref(), Some("elasticpro-history-volume-2026.11"));
        assert_eq!(index_for_day("p", "capacity", "2025-01-31").as_deref(), Some("p-capacity-2025.01"));
        assert_eq!(index_for_day("p", "volume", "not a day"), None);
        let a = volume_doc("prod", "Prod", &day("2026-11-03"), 7);
        let b = volume_doc("prod", "Prod", &day("2026-11-03"), 7);
        assert_eq!(a, b, "the same day makes the same document");
    }

    #[test]
    fn a_volume_document_never_shows_a_partial_size_and_reads_back_whole() {
        let mut d = day("2026-11-03");
        d.unmeasured_size_indices = 2;
        d.sources.insert("linux".into(), SourceTotals { indices: 1, pri_bytes: Some(9), total_bytes: Some(18), docs: Some(4), unmeasured_size_indices: 1, ..SourceTotals::default() });
        let v = volume_doc("prod", "Prod", &d, 1);
        assert_eq!(v["priBytes"], Value::Null, "the dated part is not the day's size");
        assert_eq!(v["totalBytes"], Value::Null);
        assert_eq!(v["sources"]["linux"]["priBytes"], Value::Null);
        assert_eq!(v["subBytes"], Value::Null, "not measured stays null, never 0");
        let (c, back) = day_from_doc(&v).unwrap();
        assert_eq!(c, "prod");
        assert_eq!(back.sizes(), (None, None));
        assert_eq!(back.docs, Some(10));
        assert_eq!(back.sources["linux"].docs, Some(4));
        let whole = volume_doc("prod", "Prod", &day("2026-11-02"), 1);
        assert_eq!(day_from_doc(&whole).unwrap().1.sizes(), (Some(100), Some(200)));
    }

    #[test]
    fn disk_counts_data_nodes_only_and_unknown_stays_unknown() {
        let nodes = json!([
            { "name": "hot-1", "node.role": "dhs", "disk.total": "1000", "disk.used": "600", "disk.avail": "400" },
            { "name": "master-1", "node.role": "m", "disk.total": "50", "disk.used": "10", "disk.avail": "40" },
            { "name": "frozen-1", "node.role": "f", "disk.total": "500", "disk.used": "100", "disk.avail": "400" },
        ]);
        let alloc = json!([{ "node": "hot-1", "disk.total": "1100", "disk.used": "650", "disk.avail": "450" }]);
        assert_eq!(data_node_disk(&nodes, Some(&alloc)), (Some(1600), Some(750), Some(850), Some(2)));
        assert_eq!(data_node_disk(&nodes, None), (Some(1500), Some(700), Some(800), Some(2)));
        let blind = json!([{ "name": "d1", "node.role": "d", "disk.total": null }]);
        assert_eq!(data_node_disk(&blind, None).0, None, "a node whose disk cannot be read is not 0");
        assert_eq!(data_node_disk(&json!([{ "name": "m", "node.role": "mi" }]), None), (None, None, None, Some(0)));
    }

    #[test]
    fn the_capacity_document_holds_measurements_and_settings_as_typed() {
        let nodes = json!([{ "name": "d", "node.role": "d", "disk.total": "10", "disk.used": "4", "disk.avail": "6" }]);
        let entry = json!({ "liveRetention": "30d", "backupCapacity": "2 TB" });
        let doc = capacity_doc(&CapacityInputs {
            cluster: "prod", name: "Prod", day: parse_day("2026-11-04").unwrap(), nodes: Some(&nodes), alloc: None,
            nodes_fetched_at: Some(9), oldest_live: parse_day("2026-10-05"), entry: Some(&entry), meta: None,
            last7: vec![("2026-11-03".into(), Some(5)), ("2026-11-02".into(), None)], now_ms: 1,
        });
        assert_eq!(doc["dataNodeDiskTotal"], json!(10));
        assert_eq!(doc["liveRetentionHeldDays"], json!(30));
        assert_eq!(doc["liveRetentionPolicy"], json!("30d"));
        assert_eq!(doc["snapshotRetention"], Value::Null, "not set is null");
        assert_eq!(doc["backupCapacity"], json!("2 TB"));
        assert_eq!(doc["repositoryBytes"], Value::Null, "not measured, never 0");
        assert_eq!(doc["perDayEventBytes7d"][1]["eventBytes"], Value::Null);
        for verdict in ["requiredLive", "shortfall", "buffer", "fits"] {
            assert!(!doc.to_string().to_ascii_lowercase().contains(&verdict.to_ascii_lowercase()), "no verdict in the store: {verdict}");
        }
    }

    #[test]
    fn bulks_are_cut_per_cluster_capped_and_indexed_under_the_prefix_in_force() {
        let mut queue = BTreeMap::new();
        for c in ["a", "b"] {
            for i in 0..(BULK_MAX_DOCS + 3) {
                queue.insert(("volume".into(), c.to_string(), format!("{c}|{i:05}")), q("2026-11-03"));
            }
        }
        queue.insert(("capacity".into(), "a".into(), "a|d".into()), q("2026-11-04"));
        queue.insert(("capacity".into(), "b".into(), "b|d".into()), q("2026-11-04"));
        let bulks = cut_bulks(&queue, 100);
        // capacity (both clusters together), a: 500 + 3, b: 500 + 3
        assert_eq!(bulks.iter().map(Vec::len).collect::<Vec<_>>(), vec![2, BULK_MAX_DOCS, 3, BULK_MAX_DOCS, 3]);
        assert!(bulks[1].iter().all(|k| k.1 == "a") && bulks[3].iter().all(|k| k.1 == "b"), "one cluster per volume bulk");
        assert_eq!(cut_bulks(&queue, 2).len(), 2, "bounded per tick");
        let items: Vec<(&QKey, &Queued)> = queue.iter().take(2).collect();
        // F1: the index comes from the prefix at send time, not the one when it was queued.
        for prefix in ["elasticpro-history", "ep-other"] {
            let body = bulk_body(prefix, &items);
            assert_eq!(body.lines().count(), 4);
            assert!(body.contains(&format!(r#""_index":"{prefix}-capacity-2026.11""#)), "{body}");
            assert!(crate::guard::history_guard(Writes::HistoryWrite, prefix, "POST", "/_bulk", Some(&body)).is_none(),
                    "what the writer builds is what the guard lets through");
        }
    }

    #[test]
    fn the_template_passes_its_own_guard_and_holds_no_settings() {
        let t = template_body("elasticpro-history");
        assert!(t["template"].get("settings").is_none(), "retention is the store owner's");
        assert!(crate::guard::history_guard(Writes::HistoryWrite, "elasticpro-history", "PUT",
                &format!("/_index_template/{}?create=true", template_name("elasticpro-history")), Some(&t.to_string())).is_none());
    }

    #[test]
    fn a_bulk_answer_says_per_item_what_to_keep_and_what_to_give_up() {
        let res = json!({ "errors": true, "items": [
            { "index": { "status": 201 } },
            { "index": { "status": 400, "error": { "type": "mapper_parsing_exception", "reason": "bad" } } },
            { "index": { "status": 429, "error": { "type": "es_rejected_execution_exception", "reason": "busy" } } } ] });
        let items = bulk_items(&res, 4);
        assert_eq!(items[0], Item::Taken);
        assert!(matches!(&items[1], Item::Rejected(w) if w.contains("mapper_parsing_exception")));
        assert!(matches!(&items[2], Item::Kept(w) if w.contains("busy")));
        assert!(matches!(&items[3], Item::Kept(_)), "an item the answer does not mention is kept, not taken");
        assert!(bulk_items(&json!({}), 2).iter().all(|i| matches!(i, Item::Kept(_))), "an answer without items took nothing");
    }

    #[test]
    fn privileges_read_per_privilege() {
        let res = json!({ "cluster": { "manage_index_templates": true },
                          "index": { "p-*": { "create_doc": true, "create_index": false, "read": true } } });
        let p = read_privileges(&res, "p");
        assert_eq!((p.create_doc, p.create_index, p.read, p.manage_index_templates), (Some(true), Some(false), Some(true), Some(true)));
        assert_eq!(read_privileges(&json!({}), "p").read, None, "not answered is not checked, not no");
        assert!(security_disabled(&json!({ "json": { "error": { "reason": "Security must be explicitly enabled when using a [basic] license" } } })));
    }

    #[test]
    fn settings_are_checked_and_the_secret_kept_unless_retyped() {
        let ok = parse_incoming(&json!({ "url": "https://store:9200/", "auth": "basic", "user": "w", "password": "*", "prefix": "" })).unwrap();
        assert_eq!(ok.url, "https://store:9200");
        assert_eq!(ok.prefix, DEFAULT_PREFIX);
        assert!(ok.secret.is_none(), "`*` keeps the one held");
        let key = parse_incoming(&json!({ "url": "https://s:9200", "auth": "apiKey", "apiKey": "abc" })).unwrap();
        assert_eq!(key.secret.as_deref(), Some("abc"));
        assert!(parse_incoming(&json!({ "url": "http://s:9200", "auth": "none" })).is_ok(), "plain http carries no credential");
        for bad in [json!({ "url": "ftp://x" }), json!({ "url": "https://u:p@x:9200" }), json!({ "url": "https://x/path" }),
                    json!({ "prefix": "Logs" }), json!({ "prefix": "a,b" }), json!({ "tls": "maybe" }), json!({ "auth": "kerberos" }),
                    // F15: a credential only over https.
                    json!({ "url": "http://s:9200", "auth": "basic", "user": "w" }), json!({ "url": "http://s:9200", "auth": "apiKey" }),
                    // F6: prefixes that would capture another family's indices.
                    json!({ "prefix": "logs" }), json!({ "prefix": "metrics-ep" }), json!({ "prefix": "filebeat" }), json!({ "prefix": "logstash" })] {
            assert!(parse_incoming(&bad).is_err(), "{bad}");
        }
        assert!(parse_incoming(&json!({ "prefix": "logs" })).err().unwrap().contains("logs"), "the refusal names the family");
    }

    #[test]
    fn a_test_counts_only_for_the_settings_it_ran_on_and_a_secret_for_its_kind() {
        let mut s = Stored { url: "https://a:9200".into(), prefix: "p".into(), ..Stored::default() };
        s.test = Some(TestResult { ok: true, fingerprint: s.fingerprint(), ..TestResult::default() });
        assert!(s.test_current());
        assert_eq!(arm_blocked(&s, true), None);
        assert_eq!(arm_blocked(&s, false).as_deref(), Some(PERMIT_HINT));
        s.url = "https://b:9200".into();
        assert!(!s.test_current(), "another address is another store");
        assert!(arm_blocked(&s, true).unwrap().contains("test again"));
        s.url = "https://a:9200".into();
        s.prefix = "q".into();
        assert!(!s.test_current(), "another prefix is other indices");
        s.prefix = "p".into();
        s.sealed = Some("x".into());
        assert!(!s.test_current(), "another credential is other privileges");
        // F15: a secret typed as a password is not an API key.
        s.sealed_for = s.destination();
        s.sealed_auth = Some(AuthKind::Basic);
        assert!(!s.secret_stale());
        s.auth = AuthKind::ApiKey;
        assert!(s.secret_stale(), "switching the kind of credential needs it typed again");
        assert_ne!(seal_aad("d", AuthKind::Basic), seal_aad("d", AuthKind::ApiKey));
        // F2: the template is known per store and prefix, not per prefix.
        let a = Stored { url: "https://a:9200".into(), ..Stored::default() };
        let b = Stored { url: "https://b:9200".into(), ..Stored::default() };
        assert_ne!(a.template_key(), b.template_key());
    }

    #[test]
    fn the_missing_range_stops_where_the_local_record_starts() {
        let d = |s: &str| parse_day(s).unwrap();
        assert_eq!(missing_range(d("2026-01-01"), d("2026-11-04"), Some(d("2026-06-15"))), Some((d("2026-01-01"), d("2026-06-14"))),
                   "to the day before the first local day, not the month before it (F4)");
        assert_eq!(missing_range(d("2026-07-01"), d("2026-11-04"), Some(d("2026-06-01"))), None, "covered locally");
        assert_eq!(missing_range(d("2026-07-01"), d("2026-11-04"), None), Some((d("2026-07-01"), d("2026-11-04"))), "a new data directory");
    }

    #[test]
    fn unreachable_truncated_and_never_written_are_said_apart() {
        let rb = ReadBack { from: "2026-01-01".into(), to: "2026-01-31".into(), reachable: false, message: Some("Connection refused".into()), ..ReadBack::default() };
        let v = rb.json();
        assert_eq!(v["reachable"], json!(false));
        assert_eq!(v["days"], json!(0));
        assert!(v["message"].as_str().unwrap().starts_with("in the history store · not reachable: Connection refused"));
        let cut = ReadBack { reachable: true, truncated_before: parse_day("2025-03-02"), ..ReadBack::default() };
        assert_eq!((cut.json()["truncated"].clone(), cut.json()["truncatedBefore"].clone()), (json!(true), json!("2025-03-02")));
        let empty = ReadBack { reachable: true, template_missing: true, ..ReadBack::default() };
        assert_eq!(empty.json()["templateMissing"], json!(true));
        let body = read_back_body(&["a".into()], parse_day("2026-01-01").unwrap(), parse_day("2026-01-31").unwrap(), true, Some(&json!(["2026-01-05", "a"])));
        assert_eq!(body["search_after"], json!(["2026-01-05", "a"]), "pages, not one capped search (F5)");
        assert_eq!(body["sort"][1], json!({ "clusterId": { "order": "asc" } }), "a unique sort to page on");
        assert_eq!(body["_source"]["excludes"], json!(["sources"]));
    }

    #[test]
    fn the_queue_drops_the_oldest_days_and_skips_what_has_no_day() {
        let h = HistoryStore::open(None, false);
        let mut items = vec![];
        for i in 0..(QUEUE_MAX + 2) {
            // Keys in reverse of their days, so key order and age disagree.
            let d = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap() + Duration::days(i as i64);
            items.push((("volume".to_string(), "c".to_string(), format!("{:08}", QUEUE_MAX + 2 - i)), q(&day_key(d))));
        }
        items.push((("volume".into(), "c".into(), "bad".into()), q("not a day")));
        h.enqueue(items);
        assert_eq!(h.queue_len(), QUEUE_MAX);
        assert_eq!(h.status.lock().dropped, 2);
        let oldest = h.queue.lock().values().map(|v| v.day.clone()).min().unwrap();
        assert_eq!(oldest, "2020-01-03", "the two oldest days went, whatever their keys");
        assert_eq!(h.drop_stream("volume"), QUEUE_MAX, "a stream turned off takes its queue with it");
    }
}
