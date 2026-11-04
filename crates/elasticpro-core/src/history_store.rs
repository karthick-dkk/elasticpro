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
//!   VOLUME_DAILY / MONTHLY / MONTHLY_ALL, HISTORY_QUERY ─▶ one bounded _search ◀───── store
//! ```
//!
//! **Writes are gated twice, by people, and by nothing else** (CLAUDE.md). The global
//! `readOnly` is not used — opening it would open every monitored cluster. Instead:
//!
//! 1. `HISTORY_STORE_WRITES=true` in config.txt (hosted). Without it the store can be
//!    configured and tested (reads only), never written.
//! 2. An admin armed it (*Write history*), which is refused until a *Test connection* has
//!    passed on the settings as they are now. Disarming stops writes at the next tick.
//!
//! Both are checked where the request is built **and** at the chokepoint: `Core::es_req`
//! gives a store request `Writes::HistoryWrite` only while both stand, `Writes::HistoryRead`
//! otherwise, and `guard::history_guard` holds either to exact shapes on the store's prefix.
//! A store request goes to the store's own address whatever `cluster_id` it carries; a
//! monitored cluster's request can never carry either permission.
//!
//! **Measures, not judgements.** The documents carry inputs (sizes, retention as typed, disk
//! by data role); required disk, buffers and shortfalls stay in the UI, one definition.
//!
//! **Unknown is not zero.** A store that cannot be reached is "in the history store · not
//! reachable", never a day of zeroes; a figure the core cannot measure is `null`.

use crate::auth::Caller;
use crate::bridge::Core;
use crate::guard::history_prefix_ok;
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
/// Documents waiting at most. Past it the oldest are dropped, and the status says how many.
pub const QUEUE_MAX: usize = 20_000;
/// Days one read-back search returns at most (Elasticsearch's own default result window).
pub const READ_BACK_MAX: usize = 10_000;
/// Documents one `HISTORY_QUERY` returns at most.
pub const QUERY_MAX: usize = 5_000;
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
/// destination it was typed for.
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
    /// `ClusterSecrets::seal_own`, associated data `seal_aad(destination)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<String>,
    #[serde(default)]
    pub sealed_for: String,
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
    /// The prefix the index template was last created for, and when.
    #[serde(default)]
    pub template_for: Option<String>,
    #[serde(default)]
    pub template_at: Option<u64>,
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
                     self.sealed.as_deref().unwrap_or(""), match self.auth { AuthKind::Basic => "basic", AuthKind::ApiKey => "apiKey", AuthKind::None => "none" }] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        hex::encode(h.finalize())
    }

    /// The secret no longer opens here: the address, route or certificate setting changed
    /// since it was typed.
    pub fn secret_stale(&self) -> bool {
        self.sealed.is_some() && self.sealed_for != self.destination()
    }

    pub fn test_current(&self) -> bool {
        self.test.as_ref().is_some_and(|t| t.ok && t.fingerprint == self.fingerprint())
    }
}

/// The associated data a store secret is sealed under: moved to another destination, it does
/// not open.
pub fn seal_aad(destination: &str) -> String {
    format!("history-store|{destination}")
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
    }
    let auth = match s("auth").as_str() {
        "" | "basic" => AuthKind::Basic,
        "apiKey" => AuthKind::ApiKey,
        "none" => AuthKind::None,
        other => return Err(format!("auth {other:?} is not basic, apiKey or none")),
    };
    let tls = match s("tls").as_str() {
        "" | "auto" => "auto",
        "system" => "system",
        "insecure" => "insecure",
        other => return Err(format!("tls {other:?} is not auto, system or insecure")),
    }.to_string();
    let prefix = match s("prefix") {
        p if p.is_empty() => DEFAULT_PREFIX.to_string(),
        p if history_prefix_ok(&p) => p,
        p => return Err(format!("the prefix {p:?} must be lower case letters, digits, '.', '_' or '-', not starting with '-', '_', '+' or '.'")),
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
    /// Documents dropped because the queue was full.
    pub dropped: u64,
}

/// One document waiting: the index it goes to and its body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    pub index: String,
    pub doc: Value,
}

/// `(stream, cluster, _id)`: the order bulks are cut in, and the key a rewrite replaces.
pub type QKey = (String, String, String);

pub struct HistoryStore {
    path: Option<PathBuf>,
    queue_path: Option<PathBuf>,
    pub(crate) stored: RwLock<Stored>,
    pub(crate) status: Mutex<Status>,
    pub(crate) queue: Mutex<BTreeMap<QKey, Queued>>,
    pub(crate) backfill: Mutex<Option<Backfill>>,
    ticking: AtomicBool,
    /// One test at a time.
    testing: tokio::sync::Mutex<()>,
}

impl HistoryStore {
    /// Hosted keeps its settings and queue in the data directory; every other edition has
    /// none and answers "hosted only".
    pub fn open(data_dir: Option<&std::path::Path>, hosted: bool) -> HistoryStore {
        let dir = data_dir.filter(|_| hosted);
        let path = dir.map(|d| d.join(FILE));
        let queue_path = dir.map(|d| d.join(QUEUE_FILE));
        let stored: Stored = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let queue: Vec<(QKey, Queued)> = queue_path.as_ref().and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        HistoryStore {
            path, queue_path,
            stored: RwLock::new(stored),
            status: Mutex::new(Status::default()),
            queue: Mutex::new(queue.into_iter().collect()),
            backfill: Mutex::new(None),
            ticking: AtomicBool::new(false),
            testing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn supported(&self) -> bool {
        self.path.is_some()
    }

    fn save(&self, s: &Stored) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
        crate::volume::store::write_atomic(p, &bytes)
    }

    /// Change the settings under the lock and write them; the change is kept only when the
    /// file was written.
    pub(crate) fn update(&self, f: impl FnOnce(&mut Stored)) -> Result<Stored, String> {
        let mut g = self.stored.write();
        let mut next = g.clone();
        f(&mut next);
        next.version = 1;
        self.save(&next)?;
        *g = next.clone();
        Ok(next)
    }

    fn save_queue(&self) {
        let Some(p) = &self.queue_path else { return };
        let snapshot: Vec<(QKey, Queued)> = self.queue.lock().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if let Ok(bytes) = serde_json::to_vec(&snapshot) {
            if let Err(e) = crate::volume::store::write_atomic(p, &bytes) {
                tracing::warn!(error = %e, "history store: the queue could not be written");
            }
        }
    }

    /// Put documents in the queue (a rewrite of a waiting one replaces it). Past `QUEUE_MAX`
    /// the oldest keys go, counted.
    pub fn enqueue(&self, items: Vec<(QKey, Queued)>) {
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
                let drop: Vec<QKey> = q.keys().take(over).cloned().collect();
                for k in drop {
                    q.remove(&k);
                }
                self.status.lock().dropped += over as u64;
            }
        }
        self.save_queue();
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

/// NDJSON for some documents, all `index` actions with their `_id`.
pub fn bulk_body(items: &[(String, &Queued)]) -> String {
    let mut s = String::new();
    for (id, q) in items {
        s.push_str(&json!({ "index": { "_index": q.index, "_id": id } }).to_string());
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
        let size = v.doc.to_string().len() + v.index.len() + k.2.len() + 40;
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

/// Which items of a bulk answer were taken (by position), and the first reason one was not.
pub fn bulk_items(res: &Value, n: usize) -> (Vec<bool>, Option<String>) {
    let items = res.get("items").and_then(Value::as_array);
    let mut ok = vec![false; n];
    let mut first = None;
    if let Some(items) = items {
        for (i, it) in items.iter().enumerate().take(n) {
            let r = it.get("index").or_else(|| it.get("create"));
            match r.and_then(|r| r.get("error")) {
                None if r.is_some() => ok[i] = true,
                Some(e) => {
                    first.get_or_insert_with(|| e.get("reason").and_then(Value::as_str).unwrap_or("rejected").to_string());
                }
                None => {}
            }
        }
    } else if res.get("errors") == Some(&json!(false)) {
        ok = vec![true; n];
    }
    (ok, first)
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

/* ------------------------------------------- read-back ------------------------------------------- */

/// What one read-back search found, and how the page says so.
#[derive(Debug, Default)]
pub struct ReadBack {
    pub from: String,
    pub to: String,
    pub reachable: bool,
    pub message: Option<String>,
    pub truncated: bool,
    pub days: BTreeMap<String, Vec<Day>>,
}

impl ReadBack {
    pub fn count(&self) -> usize {
        self.days.values().map(Vec::len).sum()
    }

    /// The reply's `history` object.
    pub fn json(&self) -> Value {
        json!({ "asked": true, "from": self.from, "to": self.to, "reachable": self.reachable,
                "days": self.count(), "truncated": self.truncated,
                "message": if self.reachable { self.message.clone() }
                           else { Some(format!("in the history store · not reachable{}",
                                               self.message.as_deref().map(|m| format!(": {m}")).unwrap_or_default())) } })
    }
}

/// The read-back search: the days of these clusters in `[from, to]`, newest first.
pub fn read_back_body(clusters: &[String], from: NaiveDate, to: NaiveDate) -> Value {
    json!({
        "size": READ_BACK_MAX, "track_total_hits": true, "sort": [{ "day": { "order": "desc" } }],
        "query": { "bool": { "filter": [
            { "terms": { "clusterId": clusters } },
            { "range": { "day": { "gte": day_key(from), "lte": day_key(to), "format": "yyyy-MM-dd" } } },
        ] } },
    })
}

/// The first day of the local record for a cluster: where the history store's days stop
/// being needed. `None` when it keeps nothing.
pub fn oldest_local_day(store: &crate::volume::store::Store, cluster: &str) -> Option<NaiveDate> {
    let first = store.months(cluster).into_iter().next()?;
    store.read_month(cluster, &first).days.keys().filter_map(|k| parse_day(k)).min()
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
        let secret = match (&s.auth, &s.sealed) {
            (AuthKind::None, _) => None,
            (_, None) => return Err("the history store has no credential: type its password or API key in Config › History store".into()),
            (_, Some(sealed)) => match self.cluster_secrets.open_own(&seal_aad(&s.destination()), sealed) {
                Some(p) => Some(p),
                None => return Err("the history store's address changed since its credential was typed: type it again".into()),
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

    /// Why *Write history* cannot be turned on now, or `None`.
    fn history_arm_blocked(&self) -> Option<String> {
        if !self.history_supported() {
            return Some("the history store is hosted only".into());
        }
        if !permitted() {
            return Some(PERMIT_HINT.into());
        }
        let s = self.history_store.stored.read();
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

    /// A request to the store. `es_req` sends it to the store whatever else it says.
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
            "armBlocked": self.history_arm_blocked(),
            "writing": self.history_writes_open().err(),
            "status": {
                "lastSuccessAt": st.last_success_at, "lastError": st.last_error, "lastErrorAt": st.last_error_at,
                "docsWritten": st.docs_written, "queue": self.history_store.queue_len(), "dropped": st.dropped,
                "lastSkipped": st.last_skipped,
                "templateAt": s.template_at.filter(|_| s.template_for.as_deref() == Some(s.prefix())),
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
        let mut sealed_now: Option<(String, String)> = None;
        if let Some(secret) = &incoming.secret {
            let probe = Stored { url: incoming.url.clone(), via: incoming.via.clone(), tls: incoming.tls.clone(), ..Stored::default() };
            let dest = probe.destination();
            match self.cluster_secrets.seal_own(&seal_aad(&dest), secret) {
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
            }
            if s.auth == AuthKind::None {
                s.sealed = None;
                s.sealed_for.clear();
            }
            // Other settings are not what the last test passed on, nor what arming agreed to:
            // the switch goes off and the next write waits for a new test and a new decision.
            if s.fingerprint() != before && s.armed {
                s.armed = false;
                s.armed_by = None;
                s.armed_at = None;
            }
        });
        match res {
            Ok(s) => {
                // The transport's client for the store is built again on the next request.
                tracing::info!(target: "audit", user = %by, url = %s.url, prefix = %s.prefix(), auth = ?s.auth,
                               streams = ?s.streams, "history store configured");
                self.history_view().await
            }
            Err(e) => json!({ "ok": false, "message": format!("could not save: {e}") }),
        }
    }

    async fn history_test(self: &Arc<Self>, by: &str) -> Value {
        let _one = self.history_store.testing.lock().await;
        let s = self.history_store.stored.read().clone();
        let prefix = s.prefix().to_string();
        let mut t = TestResult { at: crate::fleet::now_ms(), by: by.into(), fingerprint: s.fingerprint(), ..TestResult::default() };
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
        let passed = t.ok;
        let res = self.history_store.update(|st| st.test = Some(t.clone()));
        tracing::info!(target: "audit", user = %by, ok = passed, message = t.message.as_deref().unwrap_or(""), "history store tested");
        let mut out = self.history_view().await;
        if let Err(e) = res {
            out["message"] = json!(format!("the test ran but could not be saved: {e}"));
        }
        out["ok"] = json!(passed);
        if !passed {
            out["message"] = json!(t.message.unwrap_or_else(|| "the test failed".into()));
        }
        if let Some(o) = out.as_object_mut() {
            o.extend(extra);
        }
        out
    }

    async fn history_arm(&self, msg: &Value, by: &str) -> Value {
        let on = msg.get("on").and_then(Value::as_bool).unwrap_or(false);
        if on {
            if let Some(why) = self.history_arm_blocked() {
                return refused(format!("Write history cannot be turned on: {why}"));
            }
        }
        let now = crate::fleet::now_ms();
        let res = self.history_store.update(|s| {
            s.armed = on;
            s.armed_by = on.then(|| by.to_string());
            s.armed_at = on.then_some(now);
        });
        if let Err(e) = res {
            return json!({ "ok": false, "message": format!("could not save: {e}") });
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

    /// Create the index template once per prefix (mappings only).
    async fn history_ensure_template(self: &Arc<Self>) -> Result<(), String> {
        let (prefix, done) = {
            let s = self.history_store.stored.read();
            (s.prefix().to_string(), s.template_for.as_deref() == Some(s.prefix()))
        };
        if done {
            return Ok(());
        }
        let res = self.es_req(self.history_req("PUT", format!("/_index_template/{}", template_name(&prefix)),
                                               Some(template_body(&prefix).to_string()), 30_000)).await;
        if !ok(&res) {
            return Err(format!("the index template: {}", why(&res)));
        }
        let now = crate::fleet::now_ms();
        self.history_store.update(|s| {
            s.template_for = Some(prefix.clone());
            s.template_at = Some(now);
        })?;
        tracing::info!(target: "audit", prefix = %prefix, "history store: index template created");
        Ok(())
    }

    /// Send one bulk to the store; which items it took.
    async fn history_send_bulk(self: &Arc<Self>, body: String, n: usize) -> Result<(Vec<bool>, Option<String>), String> {
        let res = self.es_req(self.history_req("POST", "/_bulk".into(), Some(body), 60_000)).await;
        if !ok(&res) {
            return Err(why(&res));
        }
        Ok(bulk_items(res.get("json").unwrap_or(&Value::Null), n))
    }

    fn history_note_error(&self, e: &str) {
        let mut st = self.history_store.status.lock();
        st.last_error = Some(e.to_string());
        st.last_error_at = Some(crate::fleet::now_ms());
    }

    fn history_note_written(&self, n: u64) {
        let mut st = self.history_store.status.lock();
        st.docs_written += n;
        st.last_success_at = Some(crate::fleet::now_ms());
    }

    /// One tick: when both gates are open, the template, then the queue in bulks. A bulk that
    /// fails stays queued for the next tick; the local record is never held up by it.
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
        let (mut written, mut error) = (0u64, None::<String>);
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
            let refs: Vec<(String, &Queued)> = items.iter().map(|(k, v)| (k.2.clone(), v)).collect();
            match self.history_send_bulk(bulk_body(&refs), items.len()).await {
                Err(e) => {
                    error = Some(format!("bulk: {e}; kept for the next tick"));
                    break;
                }
                Ok((taken, first)) => {
                    let mut q = self.history_store.queue.lock();
                    for ((k, sent), took) in items.iter().zip(&taken) {
                        // Taken, and not rewritten while it was on its way.
                        if *took && q.get(k) == Some(sent) {
                            q.remove(k);
                        }
                    }
                    drop(q);
                    let n = taken.iter().filter(|t| **t).count() as u64;
                    written += n;
                    if let Some(f) = first {
                        error = Some(format!("{} of {} documents rejected: {f}; kept for the next tick", items.len() as u64 - n, items.len()));
                    }
                }
            }
        }
        if written > 0 {
            self.history_note_written(written);
        }
        match &error {
            Some(e) => self.history_note_error(e),
            None => self.history_store.status.lock().last_error = None,
        }
        self.history_store.save_queue();
        if written > 0 || error.is_some() {
            tracing::info!(target: "audit", written, queue = self.history_store.queue_len(), error = error.as_deref().unwrap_or(""), "history store: bulk written");
        }
        json!({ "ok": error.is_none(), "written": written, "queue": self.history_store.queue_len(), "error": error })
    }

    /* ------------------------------------------- streams ------------------------------------------- */

    fn history_stream_on(&self, stream: &str) -> bool {
        let s = self.history_store.stored.read();
        s.configured() && match stream {
            "volume" => s.streams.volume,
            "capacity" => s.streams.capacity,
            "delay" => s.streams.delay,
            _ => false,
        }
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
        let prefix = self.history_store.stored.read().prefix().to_string();
        let name = self.cluster_name(cluster);
        let now = crate::fleet::now_ms();
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
                let (Some(day), Some(index)) = (file.days.get(d), index_for_day(&prefix, "volume", d)) else { continue };
                items.push((("volume".into(), cluster.to_string(), day_id(cluster, d)),
                            Queued { index, doc: volume_doc(cluster, &name, day, now) }));
            }
        }
        self.history_store.enqueue(items);
    }

    /// After a cluster's scheduled daily run: its capacity document for today, once a day.
    pub(crate) async fn history_capacity_after_run(&self, cluster: &str) {
        if !self.history_stream_on("capacity") || self.history_writes_open().is_err() {
            return;
        }
        let today = utc_day(crate::fleet::now_ms() as i64);
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
            oldest_live, entry: entry.as_ref(), meta: meta.as_ref(), last7, now_ms: crate::fleet::now_ms(),
        });
        let prefix = self.history_store.stored.read().prefix().to_string();
        let Some(index) = index_for_day(&prefix, "capacity", &day_key(today)) else { return };
        self.history_store.enqueue(vec![(("capacity".into(), cluster.to_string(), day_id(cluster, &day_key(today))), Queued { index, doc })]);
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
            let (taken, first) = bulk_items(res.get("json").unwrap_or(&Value::Null), n);
            self.history_note_written(taken.iter().filter(|t| **t).count() as u64);
            if let Some(f) = first {
                self.history_note_error(&format!("delay: {f}"));
            }
        } else {
            self.history_note_error(&format!("delay: {}", why(&res)));
        }
        res
    }

    /// `delayStore` for `DELAY_SINK_GET`: whether the history store could take the
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
            *b = Some(Backfill { running: true, started_at: crate::fleet::now_ms(), ..Backfill::default() });
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
            let prefix = self.history_store.stored.read().prefix().to_string();
            let name = self.cluster_name(cluster);
            let now = crate::fleet::now_ms();
            let file = store.read_month(cluster, m);
            let items: Vec<(String, Queued)> = file.days.values().filter_map(|d| {
                Some((day_id(cluster, &d.day), Queued { index: index_for_day(&prefix, "volume", &d.day)?, doc: volume_doc(cluster, &name, d, now) }))
            }).collect();
            for page in items.chunks(BULK_MAX_DOCS) {
                if let Err(why) = self.history_writes_open() {
                    error = Some(format!("stopped: {why}"));
                    break 'files;
                }
                let refs: Vec<(String, &Queued)> = page.iter().map(|(id, q)| (id.clone(), q)).collect();
                match self.history_send_bulk(bulk_body(&refs), page.len()).await {
                    Err(e) => {
                        error = Some(format!("{cluster} {m}: {e}"));
                        break 'files;
                    }
                    Ok((taken, first)) => {
                        let n = taken.iter().filter(|t| **t).count() as u64;
                        self.history_note_written(n);
                        if let Some(b) = self.history_store.backfill.lock().as_mut() {
                            b.docs += n;
                        }
                        if let Some(f) = first {
                            error = Some(format!("{cluster} {m}: {} of {} rejected: {f}", page.len() as u64 - n, page.len()));
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
            b.finished_at = Some(crate::fleet::now_ms());
            b.error = error.clone();
            tracing::info!(target: "audit", files = b.done, docs = b.docs, error = error.as_deref().unwrap_or(""), "history store: copy finished");
        }
    }

    /* ------------------------------------------- read-back ------------------------------------------- */

    /// The volume days of these clusters in `[from, to]` from the store, in one search.
    /// `None` when there is no store to ask (not hosted, not configured).
    pub(crate) async fn history_read_volume(self: &Arc<Self>, clusters: &[String], from: NaiveDate, to: NaiveDate) -> Option<ReadBack> {
        if clusters.is_empty() || !self.history_supported() || !self.history_store.stored.read().configured() {
            return None;
        }
        let prefix = self.history_store.stored.read().prefix().to_string();
        let mut rb = ReadBack { from: day_key(from), to: day_key(to), ..ReadBack::default() };
        let res = self.es_req(self.history_req("POST", format!("/{prefix}-volume-*/_search?ignore_unavailable=true&allow_no_indices=true"),
                                               Some(read_back_body(clusters, from, to).to_string()), 10_000)).await;
        if !ok(&res) {
            rb.message = Some(why(&res));
            return Some(rb);
        }
        rb.reachable = true;
        let hits = res.pointer("/json/hits/hits").and_then(Value::as_array).cloned().unwrap_or_default();
        let total = res.pointer("/json/hits/total/value").and_then(Value::as_u64).unwrap_or(hits.len() as u64);
        rb.truncated = total > hits.len() as u64;
        if rb.truncated {
            rb.message = Some(format!("{} of {total} days read: the oldest are not shown", hits.len()));
        }
        for h in &hits {
            if let Some((c, d)) = h.get("_source").and_then(day_from_doc) {
                if clusters.contains(&c) {
                    rb.days.entry(c).or_default().push(d);
                }
            }
        }
        Some(rb)
    }

    /// `HISTORY_QUERY {stream, clusterId, from?, to?}` (user; the gate keeps a scoped caller to
    /// the clusters they see): the store's documents for one cluster, oldest first, bounded.
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
        let today = utc_day(crate::fleet::now_ms() as i64);
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
        let res = self.es_req(self.history_req("POST", format!("/{prefix}-{stream}-*/_search?ignore_unavailable=true&allow_no_indices=true"),
                                               Some(body.to_string()), 15_000)).await;
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
    fn bulks_are_cut_per_cluster_and_capped() {
        let mut q = BTreeMap::new();
        for c in ["a", "b"] {
            for i in 0..(BULK_MAX_DOCS + 3) {
                q.insert(("volume".into(), c.to_string(), format!("{c}|{i:05}")), Queued { index: "p-volume-2026.11".into(), doc: json!({ "i": i }) });
            }
        }
        q.insert(("capacity".into(), "a".into(), "a|d".into()), Queued { index: "p-capacity-2026.11".into(), doc: json!({}) });
        q.insert(("capacity".into(), "b".into(), "b|d".into()), Queued { index: "p-capacity-2026.11".into(), doc: json!({}) });
        let bulks = cut_bulks(&q, 100);
        // capacity (both clusters together), a: 500 + 3, b: 500 + 3
        assert_eq!(bulks.iter().map(Vec::len).collect::<Vec<_>>(), vec![2, BULK_MAX_DOCS, 3, BULK_MAX_DOCS, 3]);
        assert!(bulks[1].iter().all(|k| k.1 == "a") && bulks[3].iter().all(|k| k.1 == "b"), "one cluster per volume bulk");
        assert_eq!(cut_bulks(&q, 2).len(), 2, "bounded per tick");
        let items: Vec<(String, &Queued)> = q.iter().take(2).map(|(k, v)| (k.2.clone(), v)).collect();
        let body = bulk_body(&items);
        assert_eq!(body.lines().count(), 4);
        assert!(body.starts_with(r#"{"index":{"_id":"a|d","_index":"p-capacity-2026.11"}}"#) || body.contains(r#""_id":"a|d""#), "{body}");
        assert!(crate::guard::history_guard(crate::guard::Writes::HistoryWrite, "p", "POST", "/_bulk", Some(&body)).is_none(),
                "what the writer builds is what the guard lets through");
    }

    #[test]
    fn the_template_passes_its_own_guard_and_holds_no_settings() {
        let t = template_body("elasticpro-history");
        assert!(t["template"].get("settings").is_none(), "retention is the store owner's");
        assert!(crate::guard::history_guard(crate::guard::Writes::HistoryWrite, "elasticpro-history", "PUT",
                &format!("/_index_template/{}", template_name("elasticpro-history")), Some(&t.to_string())).is_none());
    }

    #[test]
    fn a_partly_rejected_bulk_keeps_the_rejected() {
        let res = json!({ "errors": true, "items": [
            { "index": { "status": 201 } }, { "index": { "status": 400, "error": { "reason": "mapper_parsing_exception" } } } ] });
        let (taken, first) = bulk_items(&res, 2);
        assert_eq!(taken, vec![true, false]);
        assert_eq!(first.as_deref(), Some("mapper_parsing_exception"));
        assert_eq!(bulk_items(&json!({}), 2).0, vec![false, false], "an answer without items took nothing");
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
        let key = parse_incoming(&json!({ "url": "http://s:9200", "auth": "apiKey", "apiKey": "abc" })).unwrap();
        assert_eq!(key.secret.as_deref(), Some("abc"));
        for bad in [json!({ "url": "ftp://x" }), json!({ "url": "https://u:p@x:9200" }), json!({ "url": "https://x/path" }),
                    json!({ "prefix": "Logs" }), json!({ "prefix": "a,b" }), json!({ "tls": "maybe" }), json!({ "auth": "kerberos" })] {
            assert!(parse_incoming(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_test_counts_only_for_the_settings_it_ran_on() {
        let mut s = Stored { url: "https://a:9200".into(), prefix: "p".into(), ..Stored::default() };
        s.test = Some(TestResult { ok: true, fingerprint: s.fingerprint(), ..TestResult::default() });
        assert!(s.test_current());
        s.url = "https://b:9200".into();
        assert!(!s.test_current(), "another address is another store");
        s.url = "https://a:9200".into();
        s.prefix = "q".into();
        assert!(!s.test_current(), "another prefix is other indices");
        s.prefix = "p".into();
        s.sealed = Some("x".into());
        assert!(!s.test_current(), "another credential is other privileges");
    }

    #[test]
    fn the_missing_range_stops_where_the_local_record_starts() {
        let d = |s: &str| parse_day(s).unwrap();
        assert_eq!(missing_range(d("2026-01-01"), d("2026-11-04"), Some(d("2026-06-01"))), Some((d("2026-01-01"), d("2026-05-31"))));
        assert_eq!(missing_range(d("2026-07-01"), d("2026-11-04"), Some(d("2026-06-01"))), None, "covered locally");
        assert_eq!(missing_range(d("2026-07-01"), d("2026-11-04"), None), Some((d("2026-07-01"), d("2026-11-04"))), "a new data directory");
    }

    #[test]
    fn unreachable_says_so_and_carries_no_days() {
        let rb = ReadBack { from: "2026-01-01".into(), to: "2026-01-31".into(), reachable: false, message: Some("Connection refused".into()), ..ReadBack::default() };
        let v = rb.json();
        assert_eq!(v["reachable"], json!(false));
        assert_eq!(v["days"], json!(0));
        assert!(v["message"].as_str().unwrap().starts_with("in the history store · not reachable"));
    }
}
