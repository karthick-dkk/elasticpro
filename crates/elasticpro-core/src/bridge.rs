//! The one message API the UI uses. Same message types as the extension's service
//! worker (PING / PRIME / FORGET / ES …) plus the desktop-only ones (tunnels, trust
//! decisions, config file, vault).

use crate::auth::{self, Caller, Edition, Role, Sessions, TokenStore, UserStore};
use crate::delay_sink::{self, SinkConfig, SinkState};
use crate::fleet::events::Reauth;
use crate::guard::Writes;
use crate::gate::Class;
use crate::http::{BodyLimit, ClusterSpec, EsRequest, Route, Transport};
use crate::socks::{self, SocksServer};
use crate::ssh::{JumpSpec, Tunnel};
use crate::tls::{PinStore, TlsMode};
use crate::zbx_sso::{self, ZabbixSso};
use crate::zabbix_api::{PasswordRef, Zabbix};
use crate::hcvault::Vault;
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Primed {
    clusters: HashMap<String, ClusterSpec>,
    read_only: bool,
    /// The config's shared credential as a ready header, built by the browser from the
    /// same `authHeaderFor` every cluster's is — so this core never re-derives one. Used
    /// for Zabbix clusters when the config says to connect with ElasticPro's credentials.
    shared_auth: Option<String>,
}

/// What the config's `zabbix:` block says. Read from the server's own config file at each
/// sync — never from a request — so only whoever can edit that file (an admin, on the
/// Config page) can change it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ZbxOptions {
    /// Connect Zabbix clusters with ElasticPro's credentials instead of Vault's.
    pub use_elasticpro_credentials: bool,
    /// Create a Zabbix host for each config cluster Zabbix does not have yet.
    pub create_hosts: bool,
    /// The host group created hosts go in, besides their client's.
    pub host_group: String,
    /// Limit a Zabbix User's sign-in to the clusters their Zabbix user groups are mapped to.
    /// Off by default: everyone who signs in through Zabbix reads every cluster, which is
    /// what a team that already decides access in Zabbix expects.
    pub scope_users_by_group: bool,
    /// Which Zabbix role becomes which ElasticPro role at sign-in (`zabbix.roleMap`).
    pub role_map: zbx_sso::RoleMap,
}

impl ZbxOptions {
    /// The config file's options, with whatever config.txt manages laid over them — here,
    /// once, so every caller (the sync, the sign-in scope) gets the same answer.
    pub fn from_config(raw: &Value) -> ZbxOptions {
        ZbxOptions::from_config_with(raw, crate::settings::get())
    }

    pub fn from_config_with(raw: &Value, managed: &crate::settings::Settings) -> ZbxOptions {
        let z = raw.get("zabbix").cloned().unwrap_or(Value::Null);
        let flag = |a: &str, b: &str| z.get(a).or_else(|| z.get(b)).and_then(|v| v.as_bool()).unwrap_or(false);
        ZbxOptions {
            use_elasticpro_credentials: managed.flag("ZABBIX_USE_ELASTICPRO_CREDENTIALS")
                .unwrap_or_else(|| flag("useElasticProCredentials", "use_elasticpro_credentials")),
            create_hosts: managed.flag("ZABBIX_CREATE_HOSTS").unwrap_or_else(|| flag("createHosts", "create_hosts")),
            host_group: managed.text("ZABBIX_HOST_GROUP").map(String::from).unwrap_or_else(|| {
                z.get("hostGroup").or_else(|| z.get("host_group")).and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty()).unwrap_or("Elasticsearch clusters").to_string()
            }),
            scope_users_by_group: managed.flag("ZABBIX_SCOPE_USERS_BY_GROUP")
                .unwrap_or_else(|| flag("scopeUsersByGroup", "scope_users_by_group")),
            role_map: zbx_sso::RoleMap::from_config(&z),
        }
    }
}

/// A config as a file: JSON in the order the UI writes it (`serializeConfig` in
/// core/config.js — version, credentials, defaults, jump_hosts, clusters, then the rest),
/// so a save from here and a save from the Config page diff cleanly against each other.
/// `yaml` keeps a YAML file YAML.
pub fn serialize_config(raw: &Value, yaml: bool) -> String {
    if yaml {
        return serde_yaml::to_string(raw).unwrap_or_default();
    }
    let Some(m) = raw.as_object() else { return serde_json::to_string_pretty(raw).unwrap_or_default() + "\n" };
    let mut keys: Vec<&String> = vec![];
    for k in ["version", "credentials", "defaults", "jump_hosts", "clusters"] {
        if let Some((k, _)) = m.get_key_value(k) {
            keys.push(k);
        }
    }
    let rest: Vec<&String> = m.keys().filter(|k| !keys.contains(k)).collect();
    keys.extend(rest);
    let mut out = String::from("{\n");
    for (i, k) in keys.iter().enumerate() {
        let text = serde_json::to_string_pretty(&m[*k]).unwrap_or_default().replace('\n', "\n  ");
        out.push_str(&format!("  {}: {}{}\n", serde_json::to_string(k).unwrap_or_default(), text, if i + 1 < keys.len() { "," } else { "" }));
    }
    out.push_str("}\n");
    out
}

/// Write `text` to `p` by way of a temporary file and a rename, so a reader never sees
/// half a file. 0600 for a file being created, but never a downgrade of one that already
/// exists: forcing it unconditionally once locked the operator out of their own config
/// file — the hosted stack deliberately shares it between the container and the host user.
async fn write_text_atomic(p: &std::path::Path, text: &str) -> Result<(), String> {
    let tmp = p.with_extension("tmp");
    if let Some(dir) = p.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    tokio::fs::write(&tmp, text).await.map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(p).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o600);
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    tokio::fs::rename(&tmp, p).await.map_err(|e| format!("cannot replace {}: {e}", p.display()))
}

/// The server's config file, found and parsed (`Core::locate_config`).
struct LocatedConfig {
    path: PathBuf,
    /// The file is YAML, and a save keeps it so.
    yaml: bool,
    raw: Value,
}

pub(crate) struct Route1 {
    pub(crate) tunnel: Arc<Tunnel>,
    socks: SocksServer,
}

/// The answer to `GET /sso/zabbix/role`: the status, the exact body bytes, and the
/// `X-ElasticPro-Signature` over them (present only when the question verified).
#[derive(Debug, Clone)]
pub struct RoleReply {
    pub status: u16,
    pub body: Vec<u8>,
    pub signature: Option<String>,
}

pub struct Core {
    pins: Arc<PinStore>,
    transport: Transport,
    primed: RwLock<Primed>,
    pub(crate) tunnels: tokio::sync::RwLock<HashMap<String, Route1>>,
    data_dir: Option<PathBuf>,
    /// What people did, for a SIEM and for the Accounts page. Owned here rather than by a
    /// transport so the desktop app, the bridge and the tests all feed the same record.
    activity: crate::activity::ActivityLog,
    /// `--config <path>` or ELASTICPRO_CONFIG: a config file to offer when none is remembered.
    config_hint: Option<String>,
    /// The operator's write unlock. Session-only on purpose: never written to disk and
    /// never surviving a restart, so the app always starts read-only.
    writes_unlocked: std::sync::atomic::AtomicBool,
    /// When each request left for each cluster, so "how hard are we hitting it" is a
    /// number rather than a guess. Trimmed to the reporting window on every read.
    request_log: parking_lot::Mutex<HashMap<String, std::collections::VecDeque<std::time::Instant>>>,
    requests: parking_lot::Mutex<RequestLog>,
    /// In-flight page requests by abort key (person + origin), with how many are running:
    /// `ABORT_REQUESTS` wakes a key's waiters and each of them answers "aborted" instead
    /// of waiting out the cluster. The poller and the schedules are never in here.
    aborts: parking_lot::Mutex<HashMap<String, AbortSlot>>,
    /// A short id for this core, so its requests can be told from another install's.
    instance: String,
    started: std::time::Instant,
    /// Which build this is. Portable has no accounts and never asks anyone to log in.
    edition: Edition,
    users: UserStore,
    pub(crate) sessions: Sessions,
    tokens: TokenStore,
    keys: crate::vault_files::KeyStore,
    history: crate::vault_files::ConfigHistory,
    /// The scheduled log-delay measurement. Hosted only, disarmed until an admin says
    /// otherwise, and the only thing in this process that acts without being asked.
    delay_sink: RwLock<Sink>,
    /// Signing in from Zabbix. Hosted only; off until a secret is configured.
    zbx: ZabbixSso,
    /// Elasticsearch passwords the Zabbix module handed over (`POST /sso/zabbix/cluster-secret`),
    /// encrypted at rest. The Zabbix sync takes a cluster's from here when Zabbix keeps it as a
    /// Secret macro, which the API never returns. See `cluster_secrets`.
    cluster_secrets: crate::cluster_secrets::ClusterSecrets,
    /// Clusters that are Zabbix hosts, and the Zabbix API and Vault that describe them.
    /// Hosted only; off until both are configured. Rebuilt whenever the link changes —
    /// see `rebuild_zbx_api` — so it sits behind a lock and is handed out as an `Arc`.
    zbx_api: RwLock<Arc<Zabbix>>,
    /// The Zabbix connection as configured from the UI, under the server's own settings.
    /// See `zbx_link`.
    zbx_link: crate::zbx_link::ZbxLink,
    vault: Vault,
    zbx_sync: RwLock<ZbxSync>,
    /// The two writers, used for nothing but `zabbix.createHosts`. Separate credentials, so
    /// the sync that runs every few minutes can read and never write.
    zbx_writer: Zabbix,
    vault_writer: Vault,
    /// Latest Zabbix values per host, for thirty seconds. See `zabbix_metrics`.
    zbx_metrics_cache: parking_lot::Mutex<HashMap<String, (std::time::Instant, Value)>>,
    /// One Zabbix call per host and key set at a time; the others wait for its answer.
    zbx_metrics_flights: parking_lot::Mutex<HashMap<String, tokio::sync::watch::Receiver<Option<Value>>>>,
    /// The fleet cache and its poller. See `fleet`.
    pub(crate) fleet: crate::fleet::Fleet,
    /// Every request to Elasticsearch waits here for a slot. See `gate`.
    gate: Arc<crate::gate::Gate>,
    /// The gate's limits, the read cache, the response caps and the task reaper.
    req_cfg: RwLock<crate::gate::RequestConfig>,
    /// A person's reads, kept for a few seconds; and the ones on their way, shared.
    read_cache: crate::inflight::ReadCache,
    flights: Arc<crate::inflight::Flights>,
    /// Response bytes being read at once, all requests together.
    body_budget: crate::http::ByteBudget,
    /// The instance id of the run before this one, from the data dir, and the clusters it
    /// still had reads out on: the task reaper looks there once for what it left running.
    previous_instance: Option<String>,
    restart_suspects: parking_lot::Mutex<Vec<String>>,
    /// The clusters last written to the instance file, so it is rewritten only on change.
    instance_written: parking_lot::Mutex<Vec<String>>,
    reaper_started: std::sync::atomic::AtomicBool,
    task_reaper_busy: std::sync::atomic::AtomicBool,
    /// What the task reaper last did, for the Request Centre.
    task_reaper_last: parking_lot::Mutex<Value>,
    /// Each person's notification history. See `notify`.
    notify: crate::notify::NotifyStore,
    silences: crate::silences::Silences,
    saved_queries: crate::saved_queries::SavedQueries,
    /// The housekeeping scheduler's settings and what it last did. See `housekeeping`.
    pub(crate) housekeeping: crate::housekeeping::Housekeeping,
    /// Whether the request figures are pushed to Zabbix, and how that last went. See
    /// `zbx_push`.
    pub(crate) zbx_push: parking_lot::Mutex<crate::zbx_push::PushStatus>,
}

/// What the last Zabbix sync found. The specs carry credentials and never leave the core;
/// `view` is the same list with every credential taken out, for the pages.
#[derive(Default)]
struct ZbxSync {
    specs: HashMap<String, ClusterSpec>,
    view: Vec<Value>,
    last_ok: Option<u64>,
    error: Option<String>,
    skipped: Vec<String>,
    options: ZbxOptions,
    /// What the last run of `createHosts` did or could not do.
    provisioned: Vec<String>,
    /// Each cluster template the last sync read, with how many hosts it held.
    templates: Vec<Value>,
}

/// What the job is set to do, and what it last did. Kept together because an admin
/// reading one always wants the other: "every two hours" means nothing without "and the
/// last four attempts were refused because the config is read-only".
#[derive(Default)]
struct Sink {
    config: SinkConfig,
    state: SinkState,
}

/// The window the request counter reports over.
pub const REQUEST_WINDOW: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// How many finished requests the core remembers for the Request Centre.
pub const REQUEST_LOG_KEEP: usize = 2000;
/// The most of a request path a record keeps, in characters.
pub const REQUEST_PATH_KEEP: usize = 600;
/// The most in-flight records kept; beyond it the oldest is dropped.
pub const REQUEST_INFLIGHT_KEEP: usize = 1000;

/// One request to a cluster, as the Request Centre shows it: who asked, what, how long it
/// took and how it ended. Kept for every request the core sends — the poller's and the
/// pages' alike — since both go through `es_req`; and for every request answered without
/// going to the cluster (shared with one already on its way, from the read cache, refused
/// at the gate), so what people asked for and what the clusters were sent can both be read.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub id: u64,
    pub cluster: String,
    pub origin: String,
    pub method: String,
    pub path: String,
    /// Unix milliseconds.
    pub started_at: u64,
    pub ms: Option<u64>,
    pub ok: Option<bool>,
    /// HTTP status, or the core's own kind when there was no answer (`timeout`,
    /// `unreachable`, `overloaded`, `queue_timeout`, `aborted`, `client_gone`, `reaped`).
    pub status: Option<String>,
    pub via: Option<String>,
    /// The signed-in person behind a page's request; none for the poller and the schedules.
    pub user: Option<String>,
    /// `interactive`, `prompted` or `background`: who the gate served it as.
    pub class: &'static str,
    /// `queued` (waiting for a slot), `running` (sent), `shared` (waiting on another's
    /// request), `done`.
    pub state: &'static str,
    /// How long it waited for a slot, once it had one.
    pub queued_ms: Option<u64>,
    /// Answered by a request somebody else had already sent; `leader` is that one's id.
    pub shared: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader: Option<u64>,
    /// Answered from the read cache; `ageMs` is how old the answer was.
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_ms: Option<u64>,
    /// Size of the answer's body, when one was read.
    pub bytes: Option<u64>,
    pub timeout_ms: u64,
    /// Whether it reached the cluster, and whether it only read: an abandoned read that did
    /// is what the ES task reaper looks for.
    #[serde(skip)]
    pub sent: bool,
    #[serde(skip)]
    pub read: bool,
    #[serde(skip)]
    pub begun: std::time::Instant,
    #[serde(skip)]
    pub running_since: Option<std::time::Instant>,
}

/// A record about to be begun.
pub struct NewRecord<'a> {
    pub cluster: &'a str,
    pub origin: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub via: Option<&'a str>,
    pub user: Option<&'a str>,
    pub class: crate::gate::Class,
    pub state: &'static str,
    pub timeout_ms: u64,
    pub read: bool,
}

/// Outcomes that leave a read possibly still running on the cluster.
const ABANDONED: &[&str] = &["aborted", "client_gone", "reaped", "timeout"];

/// In-flight requests by id, and the most recent finished ones, newest last.
#[derive(Default)]
pub struct RequestLog {
    next: u64,
    pub inflight: HashMap<u64, RequestRecord>,
    pub recent: std::collections::VecDeque<RequestRecord>,
    /// Clusters where a read we sent was let go of before its answer, and when: where the
    /// ES task reaper looks.
    pub abandoned: HashMap<String, u64>,
}

impl RequestLog {
    pub fn begin(&mut self, n: NewRecord<'_>) -> u64 {
        self.next += 1;
        let id = self.next;
        // A path is kept for the operator to recognise a request by, not reproduced in full:
        // a console request can carry kilobytes of query string, and the log keeps thousands
        // of records. The wire request is untouched.
        let path: String = if n.path.chars().count() > REQUEST_PATH_KEEP {
            format!("{}…", n.path.chars().take(REQUEST_PATH_KEEP).collect::<String>())
        } else { n.path.to_string() };
        // In flight is bounded by the gate's queue; this is the backstop for a transport
        // that never answers, so the map cannot grow without limit.
        if self.inflight.len() >= REQUEST_INFLIGHT_KEEP {
            if let Some(oldest) = self.inflight.values().min_by_key(|r| r.started_at).map(|r| r.id) {
                self.inflight.remove(&oldest);
            }
        }
        let started_at = crate::fleet::now_ms();
        self.inflight.insert(id, RequestRecord {
            id, cluster: n.cluster.to_string(), origin: n.origin.to_string(), method: n.method.to_string(),
            path, started_at, ms: None, ok: None, status: None, via: n.via.map(String::from), user: n.user.map(String::from),
            class: n.class.as_str(), state: n.state, queued_ms: None, shared: false, leader: None, cached: false, age_ms: None,
            bytes: None, timeout_ms: n.timeout_ms, sent: false, read: n.read, begun: std::time::Instant::now(), running_since: None,
        });
        id
    }

    /// It has its slot and is on its way to the cluster.
    pub fn running(&mut self, id: u64, queued_ms: u64) {
        if let Some(r) = self.inflight.get_mut(&id) {
            r.state = "running";
            r.queued_ms = Some(queued_ms);
            r.sent = true;
            r.running_since = Some(std::time::Instant::now());
        }
    }

    /// Change an in-flight record before it finishes.
    pub fn amend(&mut self, id: u64, f: impl FnOnce(&mut RequestRecord)) {
        if let Some(r) = self.inflight.get_mut(&id) {
            f(r);
        }
    }

    pub fn finish(&mut self, id: u64, ms: u64, ok: bool, status: String) {
        self.finish_with(id, ms, ok, status, None);
    }

    /// Finish a record. Unknown or already finished ids are left alone: whoever finishes
    /// first — the request, its abort, its drop guard, the reaper — says how it ended.
    pub fn finish_with(&mut self, id: u64, ms: u64, ok: bool, status: String, bytes: Option<u64>) -> Option<&RequestRecord> {
        let mut r = self.inflight.remove(&id)?;
        r.ms = Some(ms);
        r.ok = Some(ok);
        r.state = "done";
        if bytes.is_some() {
            r.bytes = bytes;
        }
        if r.sent && r.read && !r.shared && !r.cached && r.origin != TASK_REAPER_ORIGIN && ABANDONED.contains(&status.as_str()) {
            self.abandoned.insert(r.cluster.clone(), crate::fleet::now_ms());
        }
        r.status = Some(status);
        self.recent.push_back(r);
        while self.recent.len() > REQUEST_LOG_KEEP {
            self.recent.pop_front();
        }
        self.recent.back()
    }
}

/// The status a reply is recorded under: its HTTP status, or the core's own kind.
pub fn status_of(out: &Value) -> (bool, String) {
    let ok = out.get("ok") == Some(&json!(true));
    let status = match out.get("status").and_then(|s| s.as_u64()) {
        Some(s) if s > 0 => s.to_string(),
        _ => out.get("kind").and_then(|k| k.as_str()).unwrap_or(if ok { "ok" } else { "error" }).to_string(),
    };
    (ok, status)
}

/// The opaque id a request carries to Elasticsearch. Under 256 bytes, no spaces: the
/// install's short id, who asked, which cluster, and the record number.
pub fn opaque_id(instance: &str, origin: &str, cluster: &str, id: u64) -> String {
    use crate::tasks::clean;
    format!("{}{}/{}/{}/{}", crate::tasks::OPAQUE_PREFIX, clean(instance), clean(origin), clean(cluster), id)
}

/// The file holding this install's instance id between runs: `{current, clusters}`.
const INSTANCE_FILE: &str = "instance.json";

/// This run's instance id, the last run's, and the clusters the last run still had reads
/// out on. The file is rewritten with the new id at once.
fn instance_ids(data_dir: Option<&std::path::Path>) -> (String, Option<String>, Vec<String>) {
    let current = crate::auth::random_hex(4);
    let Some(path) = data_dir.map(|d| d.join(INSTANCE_FILE)) else { return (current, None, vec![]) };
    let before: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let previous = before.get("current").and_then(Value::as_str).filter(|p| crate::tasks::clean(p) == *p && !p.is_empty()).map(String::from);
    let clusters: Vec<String> = before.get("clusters").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|c| c.as_str().map(String::from)).take(10_000).collect();
    write_instance_file(&path, &current, &[]);
    (current, previous, clusters)
}

fn write_instance_file(path: &std::path::Path, current: &str, clusters: &[String]) {
    let text = json!({ "current": current, "clusters": clusters }).to_string();
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
        tracing::warn!(path = %path.display(), "could not record this run's instance id; after a restart its orphaned searches will not be recognised");
    }
}

/// `--config <path>` / `--config=<path>` on the command line, else $ELASTICPRO_CONFIG.
fn config_hint_from_env() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    for (i, a) in args.iter().enumerate() {
        if let Some(v) = a.strip_prefix("--config=") {
            return Some(v.to_string());
        }
        if a == "--config" {
            if let Some(v) = args.get(i + 1) {
                return Some(v.clone());
            }
        }
    }
    std::env::var("ELASTICPRO_CONFIG").ok().filter(|s| !s.trim().is_empty())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimeMsg {
    #[serde(default)]
    clusters: Vec<ClusterSpec>,
    #[serde(default)]
    jump_hosts: Vec<JumpSpec>,
    #[serde(default)]
    read_only: Option<bool>,
    /// False when the config this came from holds sealed secrets: those were unlocked by
    /// a person with the master password, and writing them to disk in the clear would
    /// undo the sealing. Absent means yes.
    #[serde(default)]
    persist: Option<bool>,
    /// Absent keeps the one held; "" clears it; anything else replaces it.
    #[serde(default)]
    shared_auth_header: Option<String>,
    /// `defaults.tls` is `insecure` in the config this came from. Used only by a core with no
    /// config file of its own (the desktop build, where the person at the keyboard opened
    /// the file); a core started with one reads the switch from it and ignores this.
    #[serde(default)]
    accept_all_certificates: Option<bool>,
}

/// Whether a config turns on `defaults.tls: insecure` — accept every certificate and SSH
/// host key, whatever a cluster's own `tls:` says.
pub fn accepts_all_certificates(raw: &Value) -> bool {
    raw.get("defaults").and_then(|d| d.get("tls")).and_then(|v| v.as_str())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("insecure"))
}

/// Where the hosted core keeps its last cluster setup, so a restart does not leave every
/// non-admin looking at "not primed" until an admin happens to open the app.
const PRIMED_FILE: &str = "primed.json";

/// Keys whose values are credentials, wherever they appear in a config. Compared
/// case-insensitively, at every depth. `CONFIG_VIEW` drops them; an admin still reads
/// the file itself.
const SECRET_KEYS: &[&str] = &[
    "password", "passphrase", "apikey", "api_key", "bearer", "authheader", "auth_header",
    "token", "secret", "secretaccesskey", "secret_access_key", "accesskeyid", "access_key_id",
    "sessiontoken", "session_token", "credentials", "credential", "keyfile", "key_file", "username",
];

/// A config with every credential taken out: secret-named keys dropped at any depth,
/// sealed values dropped, and `user:pass@` removed from URLs.
///
/// A denylist, which is normally the wrong shape for this — but the thing being filtered
/// is a document whose other keys the pages genuinely need (thresholds, index patterns,
/// alert rules), and every credential the config format accepts has one of these names.
/// The test pins that list against the parser's own field names.
pub fn redact_config(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|k, val| {
                let lk = k.to_ascii_lowercase();
                if SECRET_KEYS.contains(&lk.as_str()) {
                    return false;
                }
                !matches!(val, Value::String(s) if s.starts_with("enc:v1:"))
            });
            for val in m.values_mut() {
                redact_config(val);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(redact_config),
        Value::String(s) => {
            if let Some((scheme, rest)) = s.split_once("://") {
                let host_end = rest.find('/').unwrap_or(rest.len());
                if let Some(at) = rest[..host_end].rfind('@') {
                    *s = format!("{scheme}://{}", &rest[at + 1..]);
                }
            }
        }
        _ => {}
    }
}

/// `("es.example", "es.example:9200")` from a cluster URL — both spellings a pin may be
/// stored under.
fn host_port(url: &str) -> Option<(String, String)> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split('/').next()?.rsplit('@').next()?;
    if authority.is_empty() {
        return None;
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority).to_string();
    Some((host, authority.to_string()))
}

/// A config file's text, JSON or YAML, as a value.
fn parse_config_text(text: &str) -> Result<Value, String> {
    let t = text.trim_start_matches('\u{feff}');
    if t.trim_start().starts_with('{') {
        serde_json::from_str(t).map_err(|e| e.to_string())
    } else {
        serde_yaml::from_str(t).map_err(|e| e.to_string())
    }
}

/// Whether a raw config lists at least one cluster, under either key the file may use.
fn config_has_clusters(raw: &Value) -> bool {
    ["clusters", "hosts"].iter().any(|k| raw.get(*k).and_then(Value::as_array).is_some_and(|a| !a.is_empty()))
}

/// The Zabbix groups a raw config entry names. Both spellings, one list.
fn raw_groups(c: &Value) -> Vec<String> {
    let v = c.get("zabbixGroups").or_else(|| c.get("zabbix_groups"));
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).collect(),
        Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        _ => vec![],
    }
}

impl Core {
    /// `data_dir`: where pins.json (and nothing secret) lives. `None` = in-memory only.
    ///
    /// `edition` is a parameter rather than something detected here because only the
    /// caller knows: the Tauri shell has already worked out whether it is portable, and
    /// the bridge binary is hosted by definition. There is deliberately no default — a
    /// forgotten edition should be a compile error, not a build that quietly has no
    /// accounts.
    pub fn new(data_dir: Option<PathBuf>, edition: Edition) -> Arc<Core> {
        Core::new_with_rounds(data_dir, edition, auth::ROUNDS)
    }

    /// A core whose password hashing is deliberately cheap.
    ///
    /// Tests only. 600 000 PBKDF2 rounds in an unoptimised build is seconds per login,
    /// which turns a suite that signs in a few dozen times into one nobody runs — and the
    /// cost of the KDF is never what those tests are checking. `auth.rs` covers the real
    /// parameters on their own.
    #[doc(hidden)]
    pub fn new_with_rounds(data_dir: Option<PathBuf>, edition: Edition, rounds: u32) -> Arc<Core> {
        let server = if edition == Edition::Hosted { crate::zbx_link::ServerZbx::from_env() } else { Default::default() };
        Core::new_with_server_zbx(data_dir, edition, rounds, server)
    }

    /// A core whose "server configuration" for Zabbix is given rather than read from the
    /// environment. Tests only: the environment is one per process, and the precedence
    /// rules are exactly what the tests need to vary.
    #[doc(hidden)]
    pub fn new_with_server_zbx(data_dir: Option<PathBuf>, edition: Edition, rounds: u32,
                               server: crate::zbx_link::ServerZbx) -> Arc<Core> {
        let pins = PinStore::open(data_dir.as_ref().map(|d| d.join("pins.json")));
        // Portable keeps no accounts file at all, even if a data dir exists.
        let auth_path = |name: &str| {
            data_dir.as_ref().filter(|_| edition.uses_accounts()).map(|d| d.join(name))
        };
        let users = UserStore::open_with_rounds(auth_path("users.json"), rounds);
        // A fresh install gets the first account rather than an empty state and a
        // bootstrap screen. It opens with the shipped password until the administrator
        // changes it, and every start it still does says so.
        if edition.uses_accounts() {
            let override_file = std::env::var_os(auth::INITIAL_PASSWORD_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from);
            if let Some(seeded) = auth::seed_first_account(&users, override_file.as_deref()) {
                Core::log_seeded(&seeded, override_file.as_deref());
            } else if users.default_unchanged() {
                // Nothing here rewrites an existing accounts file; it is said out loud
                // on every start instead, until someone changes it.
                tracing::warn!(
                    user = auth::DEFAULT_USER,
                    "the first account still has the shipped password; anyone who reaches the \
                     sign-in page can use it — sign in and set your own on the Accounts page"
                );
            }
        }
        let tokens = TokenStore::open(auth_path("tokens.json"));
        let hosted = edition == Edition::Hosted;
        // The UI-managed link lives next to the accounts, and like them only on hosted.
        let zbx_link = crate::zbx_link::ZbxLink::open(
            data_dir.as_ref().filter(|_| hosted).map(|d| d.join(crate::zbx_link::LINK_FILE)),
            if hosted { server } else { Default::default() },
        );
        let resolved = zbx_link.resolved();
        let zbx = ZabbixSso::default();
        if hosted {
            if let Some(sec) = &resolved.sso_secret {
                if let Err(why) = zbx.set_secret(sec) {
                    tracing::warn!("Zabbix sign-in left off: {why}");
                }
            }
        }
        let zbx_api = Arc::new(if hosted {
            Core::zabbix_from(&resolved, Some(pins.clone()))
        } else {
            Zabbix::new(None, String::new(), String::new())
        });
        let vault = if hosted { Vault::from_env() } else { Vault::new(None, String::new(), String::new()) };
        let zbx_writer = if hosted { Zabbix::writer_from_env() } else { Zabbix::new(None, String::new(), String::new()) };
        let vault_writer = if hosted { Vault::writer_from_env() } else { Vault::new(None, String::new(), String::new()) };
        if zbx.configured() {
            tracing::info!("Zabbix sign-in is on: /sso/zabbix accepts signed requests");
        }
        let data_dir_for_sink = data_dir.clone();
        let data_dir_for_secrets = data_dir.clone();
        let data_dir_for_fleet = data_dir.clone();
        let data_dir_for_notify = data_dir.clone();
        let activity = crate::activity::ActivityLog::new(crate::activity::ActivityConfig::from_env(data_dir.as_deref(), edition));
        let (instance, previous_instance, restart_suspects) = instance_ids(data_dir.as_deref());
        let req_cfg = crate::gate::config().clone();
        Arc::new(Core {
            edition,
            activity,
            users,
            sessions: Sessions::open(auth_path("sessions.json")),
            tokens,
            keys: crate::vault_files::KeyStore::new(data_dir.as_deref()),
            history: crate::vault_files::ConfigHistory::new(data_dir.as_deref()),
            transport: Transport::new(pins.clone()),
            pins,
            primed: RwLock::new(Primed { clusters: HashMap::new(), read_only: true, shared_auth: None }),
            tunnels: tokio::sync::RwLock::new(HashMap::new()),
            data_dir,
            config_hint: config_hint_from_env(),
            writes_unlocked: std::sync::atomic::AtomicBool::new(false),
            request_log: parking_lot::Mutex::new(HashMap::new()),
            requests: parking_lot::Mutex::new(RequestLog::default()),
            aborts: parking_lot::Mutex::new(HashMap::new()),
            instance,
            previous_instance,
            restart_suspects: parking_lot::Mutex::new(restart_suspects),
            instance_written: parking_lot::Mutex::new(Vec::new()),
            reaper_started: std::sync::atomic::AtomicBool::new(false),
            task_reaper_busy: std::sync::atomic::AtomicBool::new(false),
            task_reaper_last: parking_lot::Mutex::new(Value::Null),
            started: std::time::Instant::now(),
            delay_sink: RwLock::new(Sink {
                config: read_sink_config(data_dir_for_sink.as_deref(), edition),
                state: SinkState::default(),
            }),
            zbx,
            cluster_secrets: if hosted { crate::cluster_secrets::ClusterSecrets::open(data_dir_for_secrets.as_deref()) }
                             else { crate::cluster_secrets::ClusterSecrets::in_memory() },
            zbx_api: RwLock::new(zbx_api),
            zbx_link,
            vault,
            zbx_sync: RwLock::new(ZbxSync::default()),
            zbx_writer,
            vault_writer,
            zbx_metrics_cache: parking_lot::Mutex::new(HashMap::new()),
            zbx_metrics_flights: parking_lot::Mutex::new(HashMap::new()),
            fleet: crate::fleet::Fleet::new(data_dir_for_fleet.as_deref()),
            gate: crate::gate::Gate::new(req_cfg.limits.clone()),
            body_budget: crate::http::ByteBudget::new(req_cfg.inflight_bytes),
            req_cfg: RwLock::new(req_cfg),
            read_cache: crate::inflight::ReadCache::default(),
            flights: Arc::new(crate::inflight::Flights::default()),
            silences: crate::silences::Silences::open(data_dir_for_notify.as_ref().map(|d| d.join("silences.json"))),
            saved_queries: crate::saved_queries::SavedQueries::open(data_dir_for_notify.as_ref().map(|d| d.join("saved-queries.json"))),
            notify: crate::notify::NotifyStore::open(data_dir_for_notify.map(|d| d.join("notifications.json"))),
            housekeeping: crate::housekeeping::Housekeeping::from_env(),
            zbx_push: parking_lot::Mutex::new(crate::zbx_push::PushStatus::default()),
        })
    }

    /* ------------------------------ clusters, from both places ------------------------------ */

    /// One cluster by id — a Zabbix host first, because Zabbix wins, then what an admin
    /// primed. Every per-cluster lookup goes through here so the two sources cannot be
    /// consulted in different orders in different places.
    pub(crate) fn spec_for(&self, id: &str) -> Option<ClusterSpec> {
        if let Some(s) = self.zbx_sync.read().specs.get(id) {
            return Some(s.clone());
        }
        self.primed.read().clusters.get(id).cloned()
    }

    /// Every cluster the core can reach, once each.
    pub(crate) fn all_specs(&self) -> Vec<ClusterSpec> {
        let z = self.zbx_sync.read();
        let mut out: Vec<ClusterSpec> = z.specs.values().cloned().collect();
        out.extend(self.primed.read().clusters.values().filter(|s| !z.specs.contains_key(&s.id)).cloned());
        out
    }

    /// The Zabbix sign-in, for tests and for the bridge binary's route.
    pub fn zabbix_sso(&self) -> &ZabbixSso {
        &self.zbx
    }

    /// Bring back the last cluster setup an admin applied. Hosted only, and called once
    /// at start-up by the bridge binary — the desktop app is primed by the person using
    /// it, every time, and has nobody else to serve.
    pub async fn restore_prime(self: &Arc<Self>) {
        if self.edition != Edition::Hosted {
            return;
        }
        let Some(p) = self.data_dir.as_ref().map(|d| d.join(PRIMED_FILE)) else { return };
        let Ok(text) = std::fs::read_to_string(&p) else { return };
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => {
                let out = self.prime(v).await;
                tracing::info!(clusters = out.get("count").and_then(|c| c.as_u64()).unwrap_or(0),
                               "restored the last cluster setup");
            }
            Err(e) => tracing::warn!("ignoring {}: {e}", p.display()),
        }
    }

    fn persist_prime(&self, msg: &Value, persist: bool) {
        if self.edition != Edition::Hosted {
            return;
        }
        let Some(p) = self.data_dir.as_ref().map(|d| d.join(PRIMED_FILE)) else { return };
        if !persist {
            let _ = std::fs::remove_file(&p);
            return;
        }
        let mut keep = msg.clone();
        if let Some(m) = keep.as_object_mut() {
            m.remove("type");
            m.remove("session");
        }
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, keep.to_string()).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, &p);
        }
    }

    fn forget_persisted_prime(&self) {
        if let Some(p) = self.data_dir.as_ref().map(|d| d.join(PRIMED_FILE)) {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Ids of the primed clusters this caller may see, or `None` for all of them.
    pub(crate) fn visible_ids(&self, caller: Option<&Caller>) -> Option<std::collections::HashSet<String>> {
        let c = caller?;
        c.scope.as_ref()?;
        Some(self.all_specs().into_iter().filter(|s| c.sees(&s.zabbix_groups)).map(|s| s.id).collect())
    }

    /* -------------------------------- who is asking -------------------------------- */

    pub fn edition(&self) -> Edition {
        self.edition
    }

    /// Where this core keeps its files, if anywhere. Tests read the first password from
    /// here, the same place an operator does.
    #[doc(hidden)]
    pub fn data_dir(&self) -> Option<&std::path::Path> {
        self.data_dir.as_deref()
    }

    /// The one startup line that announces the first account. Its wording ("created the
    /// first one") is what the docs tell operators to grep for. Printed once, on the start
    /// that creates the account.
    fn log_seeded(s: &auth::Seeded, override_file: Option<&std::path::Path>) {
        if let Some(why) = &s.override_error {
            tracing::error!(
                "{} not used ({why}); the account was created with the shipped password instead",
                auth::INITIAL_PASSWORD_ENV
            );
        }
        if let Some(why) = &s.save_error {
            tracing::error!("the first account could not be saved and lasts only until restart: {why}");
        }
        if s.from_override {
            tracing::warn!(
                user = auth::DEFAULT_USER,
                from = %override_file.map(|p| p.display().to_string()).unwrap_or_default(),
                "no accounts existed: created the first one, with the password from {}",
                auth::INITIAL_PASSWORD_ENV
            );
        } else {
            tracing::warn!(
                user = auth::DEFAULT_USER,
                password = auth::DEFAULT_PASSWORD,
                "no accounts existed: created the first one, with the shipped password. Anyone \
                 who reaches the sign-in page can use it until it is changed — sign in and set \
                 your own on the Accounts page"
            );
        }
    }

    /// The account store, for tests that need an account the message API cannot make
    /// (one marked `must_change`).
    #[doc(hidden)]
    pub fn users_for_tests(&self) -> &UserStore {
        &self.users
    }

    /// True when accounts apply but none exist yet, so the app must ask for a first admin
    /// before it will do anything else.
    pub fn needs_bootstrap(&self) -> bool {
        self.edition.uses_accounts() && self.users.is_empty()
    }

    /// The caller a session token names, if the session is still live.
    pub fn caller_for_session(&self, token: &str) -> Option<Caller> {
        let s = self.sessions.resolve(token)?;
        Some(Caller { name: s.user, role: s.role, must_change: s.must_change, scope: s.scope })
    }

    /// The caller for a name a trusted reverse proxy has already authenticated.
    ///
    /// `None` means "authenticated by nginx, but not someone this deployment knows",
    /// which the gate turns into a refusal. Being past the proxy is not by itself an
    /// identity here: a name with no account gets no role, including before the first
    /// account exists, when the only thing available is the bootstrap.
    pub fn caller_for_proxy_user(&self, name: &str) -> Option<Caller> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        self.users
            .list()
            .into_iter()
            .find(|a| a.name.eq_ignore_ascii_case(name) && !a.disabled)
            .map(|a| Caller { name: a.name, role: a.role, must_change: a.must_change, scope: a.scope })
    }

    /// The caller an API token names. Hosted only — see `Edition::uses_api_tokens`.
    pub fn caller_for_token(&self, secret: &str) -> Option<Caller> {
        if !self.edition.uses_api_tokens() {
            return None;
        }
        let role = self.tokens.verify(secret)?;
        // A token is not a person and has no password to change.
        Some(Caller { name: format!("token:{}", &secret[..secret.len().min(12)]), role, must_change: false, scope: None })
    }

    /// Whether this caller may send this message, as a ready-made refusal.
    ///
    /// Portable never reaches here. Everywhere else the answer is default-deny: an
    /// unknown message type needs admin, and no session means nothing but the handful of
    /// types that exist to establish one.
    fn gate(&self, t: &str, msg: &Value, caller: Option<&Caller>) -> Result<(), Value> {
        // Before the first admin exists there is nothing to authenticate against, so the
        // only thing on offer is creating one. Every edition that uses accounts, hosted
        // included.
        //
        // Hosted was briefly exempt, on the argument that nginx had already authenticated
        // the request and that enforcing accounts would lock a team out mid-incident. The
        // exemption is gone: a deployment where being past the proxy is enough has no
        // per-user identity at all, which is the thing accounts exist to provide, and
        // "authentication is required unless it would be inconvenient" is not a security
        // posture. An upgrade now shows its administrator the bootstrap screen once.
        if self.users.is_empty() {
            return match t {
                "PING" | "WHOAMI" | "BADGE" | "OPEN_APP" | "ENABLE_NET_ERRORS" | "BOOTSTRAP_ADMIN" => Ok(()),
                _ => Err(json!({
                    "ok": false, "kind": "needs_bootstrap",
                    "message": "no accounts exist yet — create the first administrator to continue",
                })),
            };
        }
        if auth::required_role(t).is_none() {
            return Ok(());
        }
        let Some(c) = caller else {
            return Err(json!({
                "ok": false, "kind": "unauthenticated",
                "message": "sign in to continue",
            }));
        };
        // The shipped password is a way in and nothing else. Until it is replaced this
        // session can see who it is, change that password, and leave.
        if c.must_change && !matches!(t, "PING" | "WHOAMI" | "LOGOUT" | "USER_SET_PASSWORD") {
            return Err(json!({
                "ok": false, "kind": "must_change_password",
                "message": "this account is still on the password it shipped with — set a new one to continue",
            }));
        }

        // Blocked: refused everything from the moment an admin says so. The session is not
        // ended — nobody is signed out — it just does nothing until it is unblocked.
        if !matches!(t, "PING" | "WHOAMI" | "LOGOUT") && self.users.is_blocked(&c.name) {
            return Err(json!({
                "ok": false, "kind": "disabled",
                "message": "this account is blocked — ask an ElasticPro administrator",
            }));
        }

        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let path = msg.get("path").and_then(|v| v.as_str()).unwrap_or("");
        auth::authorize(c.role, t, method, path).map_err(|why| {
            json!({ "ok": false, "kind": "forbidden", "role": c.role.as_str(), "message": why })
        })?;
        self.gate_cluster(t, msg, c)
    }

    /// The per-cluster half of the gate: which cluster, and where the request goes.
    ///
    /// Two rules, both for anybody below admin:
    ///
    /// * A scoped caller reaches only the clusters their Zabbix groups are mapped to. A
    ///   cluster that is not primed cannot be shown to be theirs, so it is refused too.
    /// * The request goes to the cluster's own URL with the cluster's own credential. An
    ///   `ES` message may name a `url` and an `authHeader` — the connection diagnostics
    ///   need both — and an admin still may. Anybody else naming a different URL would be
    ///   asking the core to send that cluster's stored credential to an address of their
    ///   choosing.
    fn gate_cluster(&self, t: &str, msg: &Value, c: &Caller) -> Result<(), Value> {
        if !matches!(t, "ES" | "ZABBIX_METRICS" | "CLUSTER_DATASET" | "REFRESH") || c.role >= Role::Admin {
            return Ok(());
        }
        let refuse = |why: String| json!({ "ok": false, "kind": "forbidden", "role": c.role.as_str(), "message": why });
        // REFRESH names several clusters, or "all" of the caller's. Every named one must be
        // theirs; "all" is resolved against what they may see, in the handler.
        if t == "REFRESH" {
            if let Some(ids) = msg.get("clusterIds").and_then(|v| v.as_array()) {
                for id in ids {
                    let id = id.as_str().unwrap_or("");
                    if !self.spec_for(id).is_some_and(|s| c.sees(&s.zabbix_groups)) {
                        return Err(refuse(format!("cluster {id:?} is not one of yours")));
                    }
                }
            }
            return Ok(());
        }
        let id = msg.get("clusterId").and_then(|v| v.as_str()).unwrap_or("");
        let spec = self.spec_for(id);
        if c.scope.is_some() {
            match &spec {
                Some(s) if c.sees(&s.zabbix_groups) => {}
                _ => return Err(refuse(format!(
                    "cluster {id:?} is not one of yours — ask a Zabbix administrator to add you to a user group mapped to it"
                ))),
            }
        }
        if t == "ES" {
            if msg.get("authHeader").is_some_and(|v| !v.is_null()) {
                return Err(refuse("only an admin may send a request with its own credential".into()));
            }
            if let Some(u) = msg.get("url").and_then(|v| v.as_str()) {
                let same = spec.as_ref().is_some_and(|s| s.url.trim_end_matches('/') == u.trim_end_matches('/'));
                if !same {
                    return Err(refuse("only an admin may send a cluster's request to another address".into()));
                }
            }
        }
        Ok(())
    }

    /* ---------------------------------- dispatch ---------------------------------- */

    /// Handle a message, working out who is asking from its `session` field.
    pub async fn handle(self: &Arc<Self>, msg: Value) -> Value {
        let caller = msg
            .get("session")
            .and_then(|v| v.as_str())
            .and_then(|tok| self.caller_for_session(tok));
        self.handle_as(msg, caller).await
    }

    /// Handle a message on behalf of an already-resolved caller.
    ///
    /// The hosted bridge uses this: it has an `Authorization` header to check, which the
    /// message itself knows nothing about.
    pub async fn handle_as(self: &Arc<Self>, msg: Value, caller: Option<Caller>) -> Value {
        // How this caller could be established again, for a stream that outlives the
        // request: the message's session if it carries one, else the name a proxy gave.
        // The hosted bridge knows better when it was an API token, and says so through
        // `handle_as_from`.
        let reauth = match (msg.get("session").and_then(|v| v.as_str()), &caller) {
            (Some(s), Some(_)) => Reauth::Session(s.to_string()),
            (_, Some(c)) => Reauth::Proxy(c.name.clone()),
            _ => Reauth::None,
        };
        self.handle_as_from(msg, caller, reauth).await
    }

    /// `handle_as`, told how the caller proved who they are.
    ///
    /// Every failed reply leaves with its error code (errors.rs), stamped here once.
    pub async fn handle_as_from(self: &Arc<Self>, msg: Value, caller: Option<Caller>, reauth: Reauth) -> Value {
        self.handle_as_from_at(msg, caller, reauth, None).await
    }

    /// `handle_as_from`, told the client address (the hosted bridge knows it, the desktop
    /// app has none). Every exchange is written to the activity log here, on the way out,
    /// so a refusal by the gate and a reply from a handler are recorded by the same line.
    pub async fn handle_as_from_at(self: &Arc<Self>, msg: Value, caller: Option<Caller>, reauth: Reauth, source: Option<std::net::IpAddr>) -> Value {
        self.handle_reply_as_from_at(msg, caller, reauth, source).await.into_value()
    }

    /// `handle_as_from_at`, with any cached fleet bodies left as the text they are held as
    /// (`fleet::reply`). The hosted bridge sends this with `Reply::to_json`, so a full
    /// `FLEET_STATE` never exists as a parsed `Value`; everything else is a plain `Value`
    /// inside it, unchanged.
    pub async fn handle_reply_as_from_at(
        self: &Arc<Self>, msg: Value, caller: Option<Caller>, reauth: Reauth, source: Option<std::net::IpAddr>,
    ) -> crate::fleet::reply::Reply {
        let via = match &reauth {
            Reauth::Session(_) => "session",
            Reauth::Token(_) => "token",
            Reauth::Proxy(_) => "proxy",
            Reauth::None => "none",
        };
        let sent = msg.clone();
        let mut out = self.dispatch_reply(msg, caller.clone(), reauth).await;
        crate::errors::stamp(&mut out.value);
        self.record_activity(&sent, caller.as_ref(), via, source, &out.value);
        out
    }

    /// The two messages that hand back cached bodies, as a `Reply`; everything else
    /// through `dispatch`. The gate is the same one `dispatch` applies.
    async fn dispatch_reply(self: &Arc<Self>, msg: Value, caller: Option<Caller>, reauth: Reauth) -> crate::fleet::reply::Reply {
        let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(t, "FLEET_STATE" | "CLUSTER_DATASET") {
            return self.dispatch(msg, caller, reauth).await.into();
        }
        if self.edition.uses_accounts() {
            if let Err(denied) = self.gate(t, &msg, caller.as_ref()) {
                return denied.into();
            }
        }
        if t == "FLEET_STATE" {
            self.fleet_state_reply(&msg, caller.as_ref())
        } else {
            self.cluster_dataset_reply(&msg, caller.as_ref()).await
        }
    }

    /// Write one exchange to the activity log (background polls are skipped inside).
    pub fn record_activity(&self, msg: &Value, caller: Option<&Caller>, via: &str, source: Option<std::net::IpAddr>, reply: &Value) {
        if let Some(ev) = crate::activity::ActivityEvent::from_exchange(msg, caller, via, source, reply, self.edition) {
            self.activity.record(ev);
        }
    }

    /// Wait for the activity log's writer thread to catch up with what has been recorded.
    pub fn flush_activity(&self) {
        self.activity.flush();
    }

    async fn dispatch(self: &Arc<Self>, msg: Value, caller: Option<Caller>, reauth: Reauth) -> Value {
        let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if self.edition.uses_accounts() {
            if let Err(denied) = self.gate(&t, &msg, caller.as_ref()) {
                return denied;
            }
        }
        match t.as_str() {
            "WHOAMI" => json!({
                "ok": true,
                "edition": self.edition,
                "authRequired": self.edition.uses_accounts(),
                "needsBootstrap": self.needs_bootstrap(),
                "apiTokens": self.edition.uses_api_tokens(),
                // The shipped username and whether its password still works used to ride
                // along here so the sign-in screen could print them. The screen does not
                // print them any more, and answering "is the default password still good,
                // and what is the username" to an unauthenticated caller is handing over
                // the first half of a login.
                "caller": caller.as_ref().map(|c| c.public()),
            }),
            "ACTIVITY_LIST" => {
                let limit = msg.get("limit").and_then(Value::as_u64).unwrap_or(300).clamp(1, crate::activity::RING as u64) as usize;
                let user = msg.get("user").and_then(Value::as_str);
                let failed = msg.get("failedOnly").and_then(Value::as_bool).unwrap_or(false);
                json!({ "ok": true, "events": self.activity.list(limit, user, failed), "file": self.activity.path() })
            }
            "LOGIN" => self.login(&msg),
            "SSO_EXCHANGE" => self.sso_exchange(&msg),
            "CONFIG_VIEW" => self.config_view(caller.as_ref()).await,
            "ZABBIX_CLUSTERS" => self.zabbix_clusters(caller.as_ref()),
            "ZABBIX_SYNC" => self.zabbix_sync().await,
            "ZABBIX_METRICS" => self.zabbix_metrics(&msg).await,
            "ZABBIX_LINK_GET" | "ZABBIX_LINK_SET" | "ZABBIX_LINK_TEST" | "ZABBIX_PAIR_BEGIN" | "ZABBIX_UNPAIR" => {
                self.zabbix_link_msg(&t, &msg, caller.as_ref()).await
            }
            "LOGOUT" => {
                if let Some(tok) = msg.get("session").and_then(|v| v.as_str()) {
                    self.sessions.end(tok);
                }
                json!({ "ok": true })
            }
            "BOOTSTRAP_ADMIN" => self.bootstrap_admin(&msg),
            "USER_LIST" | "USER_ADD" | "USER_REMOVE" | "USER_SET_ROLE" | "USER_UNPIN_ROLE" | "USER_SET_PASSWORD" | "USER_SET_LOCKED" | "USER_SET_BLOCKED" | "USER_LOGINS" => {
                self.users_msg(&t, &msg, caller.as_ref())
            }
            "TOKEN_LIST" | "TOKEN_CREATE" | "TOKEN_REVOKE" => self.tokens_msg(&t, &msg),
            "KEY_UPLOAD" | "KEY_LIST" | "KEY_DELETE" => self.keys_msg(&t, &msg),
            "CONFIG_HISTORY" | "CONFIG_RESTORE" => self.history_msg(&t, &msg),
            "PING" => self.ping(caller.as_ref()).await,
            "PRIME" => self.prime(msg).await,
            "FORGET" => {
                {
                    let mut p = self.primed.write();
                    p.clusters.clear();
                }
                self.read_cache.clear();
                self.forget_persisted_prime();
                self.set_writes_unlocked(false);
                self.forget_connections();
                self.close_tunnels().await;
                json!({ "ok": true })
            }
            "ES" => self.es(msg, caller.as_ref()).await,
            "ABORT_REQUESTS" => self.abort_requests(&msg, caller.as_ref()),
            "FLEET_STATE" => self.fleet_state_msg(&msg, caller.as_ref()),
            "CLUSTER_DATASET" => self.cluster_dataset_msg(&msg, caller.as_ref()).await,
            "REFRESH" => self.refresh_msg(&msg, caller.as_ref()),
            "POLICY_GET" | "POLICY_SET" => self.policy_msg(&t, &msg, caller.as_ref()),
            "EVENTS_TICKET" => self.events_ticket_msg(caller.clone(), reauth),
            "DELAY_SINK_GET" | "DELAY_SINK_SET" | "DELAY_SINK_RUN" => self.delay_sink_msg(&t, &msg).await,
            "HOUSEKEEPING_GET" | "HOUSEKEEPING_RUN" => self.housekeeping_msg(&t, &msg, caller.as_ref()).await,
            "NOTIFY_PUT" | "NOTIFY_LIST" | "NOTIFY_CLEAR" => self.notify_msg(&t, &msg, caller.as_ref()),
            // Scoped to the clusters the caller may see (Zabbix group scope): a silence names a
            // cluster, so listing, setting or removing one for a cluster you cannot see is refused.
            // Saved REST console queries: the caller's own and every shared one. The page
            // redacts secrets before saving; ownership decides who may change or delete.
            "QUERY_LIST" => {
                let user = caller.as_ref().map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
                json!({ "ok": true, "queries": self.saved_queries.visible_to(&user), "user": user })
            }
            "QUERY_SAVE" | "QUERY_DELETE" => {
                let user = caller.as_ref().map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
                // The override is for an administrator of the whole install: one limited to some
                // clusters (Zabbix group scope) manages only their own queries, like anyone else.
                let admin = caller.as_ref().is_none_or(|c| c.role >= Role::Admin && c.scope.is_none());
                let s = |k: &str| msg.get(k).and_then(Value::as_str).unwrap_or("");
                let res = if t == "QUERY_SAVE" {
                    self.saved_queries.put(&user, admin, crate::saved_queries::Draft {
                        id: msg.get("id").and_then(Value::as_str), name: s("name"), method: s("method"), path: s("path"),
                        body: s("body"), shared: msg.get("shared").and_then(Value::as_bool).unwrap_or(false), note: s("note"),
                    })
                } else {
                    self.saved_queries.delete(&user, admin, s("id"))
                };
                match res {
                    Ok(q) => json!({ "ok": true, "query": q, "queries": self.saved_queries.visible_to(&user) }),
                    Err(e) => json!({ "ok": false, "kind": if e.starts_with("only its owner") { "forbidden" } else { "bad_request" }, "message": e }),
                }
            }
            "SILENCE_LIST" => {
                let list = self.silences_visible(caller.as_ref());
                json!({ "ok": true, "silences": list })
            }
            "SILENCE_SET" => {
                let by = caller.as_ref().map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
                let (scope, target) = (msg.get("scope").and_then(Value::as_str).unwrap_or(""), msg.get("target").and_then(Value::as_str).unwrap_or(""));
                if !self.silence_allowed(caller.as_ref(), scope, target) {
                    return json!({ "ok": false, "kind": "forbidden", "message": "that is not a cluster you can see" });
                }
                let minutes = msg.get("minutes").and_then(Value::as_u64);
                match self.silences.add(scope, target, minutes, msg.get("reason").and_then(Value::as_str).unwrap_or(""), &by) {
                    Ok(s) => {
                        tracing::info!(target: "audit", user = %by, scope = %s.scope, target = %s.target, until = ?s.until, reason = %s.reason, "alert silenced");
                        json!({ "ok": true, "silence": s, "silences": self.silences_visible(caller.as_ref()) })
                    }
                    Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e }),
                }
            }
            "SILENCE_CLEAR" => {
                let by = caller.as_ref().map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
                let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
                match self.silences.list().into_iter().find(|s| s.id == id) {
                    Some(s) if !self.silence_allowed(caller.as_ref(), &s.scope, &s.target) =>
                        json!({ "ok": false, "kind": "forbidden", "message": "that silence is for a cluster you cannot see" }),
                    None => json!({ "ok": false, "kind": "not_found", "message": "no such silence (it may have ended)" }),
                    Some(_) => match self.silences.remove(id) {
                        Ok(Some(s)) => {
                            tracing::info!(target: "audit", user = %by, scope = %s.scope, target = %s.target, "alert silence removed");
                            json!({ "ok": true, "silences": self.silences_visible(caller.as_ref()) })
                        }
                        Ok(None) => json!({ "ok": false, "kind": "not_found", "message": "no such silence (it may have ended)" }),
                        Err(e) => json!({ "ok": false, "kind": "io", "message": e }),
                    },
                }
            }
            "TUNNELS" => json!({ "ok": true, "tunnels": self.tunnels_for(caller.as_ref()).await }),
            "TUNNEL_RECONNECT" => {
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("");
                let ts = self.tunnels.read().await;
                match ts.get(id) {
                    Some(r) => {
                        r.tunnel.close().await;
                        r.tunnel.reset_backoff();
                        json!({ "ok": true })
                    }
                    None => json!({ "ok": false, "message": format!("no tunnel {id}") }),
                }
            }
            "TRUST_CERT" => {
                let host = msg.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let fp = msg.get("sha256").and_then(|v| v.as_str()).map(String::from);
                let seen = self.pins.last_seen(&host);
                match (fp.or(seen.as_ref().map(|c| c.sha256.clone())), seen) {
                    (Some(fp), seen) => {
                        self.pins.trust_cert(&host, &fp, seen.as_ref().map(|c| c.subject.as_str()).unwrap_or(""));
                        self.forget_connections();
                        json!({ "ok": true, "host": host, "sha256": fp })
                    }
                    _ => json!({ "ok": false, "message": "no certificate has been seen for that host yet" }),
                }
            }
            "UNTRUST_CERT" => {
                let host = msg.get("host").and_then(|v| v.as_str()).unwrap_or("");
                self.pins.untrust_cert(host);
                self.forget_connections();
                json!({ "ok": true })
            }
            "TRUST_HOSTKEY" => {
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let ts = self.tunnels.read().await;
                let Some(r) = ts.get(&id) else { return json!({ "ok": false, "message": format!("no tunnel {id}") }) };
                let Some((fp, kt)) = r.tunnel.offered_hostkey() else {
                    return json!({ "ok": false, "message": "the jump host has not presented a key yet" });
                };
                if let Some(want) = msg.get("fingerprint").and_then(|v| v.as_str()) {
                    if want != fp {
                        return json!({ "ok": false, "message": "fingerprint no longer matches what the host offers" });
                    }
                }
                self.pins.trust_hostkey(&id, &fp, &kt);
                r.tunnel.reset_backoff();
                json!({ "ok": true, "jumpId": id, "fingerprint": fp, "keyType": kt })
            }
            "UNTRUST_HOSTKEY" => {
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("");
                self.pins.untrust_hostkey(id);
                if let Some(r) = self.tunnels.read().await.get(id) {
                    r.tunnel.close().await;
                    r.tunnel.reset_backoff();
                }
                json!({ "ok": true })
            }
            "TUNNEL_SECRET" => {
                // passphrase / password for a jump host, session only
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let passphrase = msg.get("passphrase").and_then(|v| v.as_str()).map(String::from);
                let password = msg.get("password").and_then(|v| v.as_str()).map(String::from);
                let mut ts = self.tunnels.write().await;
                let Some(old) = ts.remove(&id) else { return json!({ "ok": false, "message": format!("no tunnel {id}") }) };
                old.tunnel.close().await;
                let mut spec = old.tunnel.spec.clone();
                if passphrase.is_some() {
                    spec.passphrase = passphrase;
                }
                if password.is_some() {
                    spec.password = password;
                }
                drop(old);
                match self.make_route(spec).await {
                    Ok(r) => {
                        ts.insert(id, r);
                        self.forget_connections();
                        json!({ "ok": true })
                    }
                    Err(e) => json!({ "ok": false, "message": e }),
                }
            }
            // The operator's write unlock, for actions taken by hand in the UI. Held in
            // memory for this session only; a request must still ask for it per-request
            // (`allowWrites`), so nothing that polls in the background can write while
            // it is on.
            "WRITE_UNLOCK" => {
                let on = msg.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                self.set_writes_unlocked(on);
                json!({ "ok": true, "writesUnlocked": on })
            }
            // How many requests this app has sent to each cluster lately — the answer to
            // "are we stressing Elasticsearch", as a number.
            "REQUEST_STATS" => json!({ "ok": true, "requests": self.requests_for(caller.as_ref()) }),
            "REQUEST_LOG" => self.request_log_for(caller.as_ref(), &msg),
            "PINS" => {
                self.refresh_trust_switch().await;
                json!({ "ok": true, "pins": self.pins_for(caller.as_ref()) })
            }
            "CONFIG_READ" => {
                let path = msg.get("path").and_then(|v| v.as_str()).unwrap_or("");
                match tokio::fs::read_to_string(path).await {
                    Ok(text) => {
                        let meta = tokio::fs::metadata(path).await.ok();
                        json!({ "ok": true, "path": path, "text": text,
                                "size": meta.as_ref().map(|m| m.len()),
                                "lastModified": meta.and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64) })
                    }
                    // "not there yet" and "there but unreadable" call for different
                    // answers from the UI: the first is a fresh install, the second is a
                    // fault. Typed here so no caller has to match on the message text.
                    Err(e) => {
                        let kind = if e.kind() == std::io::ErrorKind::NotFound { "not_found" } else { "io_error" };
                        json!({ "ok": false, "kind": kind, "message": format!("cannot read {path}: {e}") })
                    }
                }
            }
            "FILE_WRITE" | "CONFIG_WRITE" | "CONFIG_WRITE_EXAMPLE" => {
                // atomic: write .tmp then rename; private permissions where the OS has them
                let path = msg.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if path.is_empty() {
                    return json!({ "ok": false, "message": "no path" });
                }
                let p = std::path::PathBuf::from(path);
                // Keep what is there before replacing it. A config edited from the UI is
                // edited by hand no longer, so an undo has to come from somewhere.
                let kept = if t == "CONFIG_WRITE" { self.history.snapshot(&p) } else { false };
                match write_text_atomic(&p, text).await {
                    Ok(()) => json!({ "ok": true, "path": path, "bytes": text.len(), "keptVersion": kept }),
                    Err(message) => json!({ "ok": false, "message": message }),
                }
            }
            "CLUSTER_SAVE" => self.cluster_save(&msg, caller.as_ref()).await,
            "AUTOMATIONS_SAVE" => self.automations_save(&msg, caller.as_ref()).await,
            "ZABBIX_ROLEMAP_GET" | "ZABBIX_ROLEMAP_SET" => self.rolemap_msg(&t, &msg, caller.as_ref()).await,
            "SEAL" => {
                let plain = msg.get("plain").and_then(|v| v.as_str()).unwrap_or("");
                let master = msg.get("master").and_then(|v| v.as_str()).unwrap_or("");
                match crate::crypto::seal(plain, master) {
                    Ok(v) => json!({ "ok": true, "value": v }),
                    Err(e) => json!({ "ok": false, "message": e }),
                }
            }
            "OPEN" => {
                let value = msg.get("value").and_then(|v| v.as_str()).unwrap_or("");
                let master = msg.get("master").and_then(|v| v.as_str()).unwrap_or("");
                match crate::crypto::open(value, master) {
                    Ok(p) => json!({ "ok": true, "plain": p }),
                    Err(crate::crypto::OpenError::WrongMaster) => json!({ "ok": false, "kind": "bad_master", "message": "master password not accepted" }),
                    Err(crate::crypto::OpenError::NotSealed) => json!({ "ok": true, "plain": value, "unsealed": true }),
                    Err(_) => json!({ "ok": false, "kind": "malformed", "message": "the encrypted value is malformed" }),
                }
            }
            #[cfg(feature = "vault")]
            "VAULT_GET" | "VAULT_SET" | "VAULT_DEL" => crate::vault::handle(&t, &msg),
            "ENABLE_NET_ERRORS" => json!({ "ok": true, "always": true }),
            "BADGE" | "OPEN_APP" => json!({ "ok": true }),
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("Unknown message type {t:?}") }),
        }
    }

    fn record_request(&self, cluster: &str) {
        let mut log = self.request_log.lock();
        let q = log.entry(cluster.to_string()).or_default();
        q.push_back(std::time::Instant::now());
        // Keep the queue bounded even for a very chatty cluster.
        while q.len() > 10_000 {
            q.pop_front();
        }
    }

    /// Requests sent to each cluster within `window` (at most `REQUEST_WINDOW`, which is
    /// all that is kept). The one count behind the Request Centre's rate and the Zabbix
    /// push's requests per minute. Old entries are dropped as they age out, so memory
    /// stays flat.
    pub(crate) fn sent_counts(&self, window: std::time::Duration) -> Vec<(String, usize)> {
        let now = std::time::Instant::now();
        let window = window.min(REQUEST_WINDOW);
        let mut log = self.request_log.lock();
        log.iter_mut().map(|(cluster, q)| {
            while q.front().map(|t| now.duration_since(*t) > REQUEST_WINDOW).unwrap_or(false) {
                q.pop_front();
            }
            // Newest at the back: count from there until one is older than the window.
            let n = q.iter().rev().take_while(|t| now.duration_since(**t) <= window).count();
            (cluster.clone(), n)
        }).collect()
    }

    /// Requests sent to each cluster in the last `REQUEST_WINDOW`, plus the rate that
    /// implies.
    pub fn request_stats(&self) -> Value {
        let secs = REQUEST_WINDOW.as_secs_f64();
        let out: serde_json::Map<String, Value> = self.sent_counts(REQUEST_WINDOW).into_iter().map(|(cluster, n)| {
            (cluster, json!({
                "last5m": n,
                "perMinute": (n as f64) / (secs / 60.0),
                "perSecond": (n as f64) / secs,
            }))
        }).collect();
        json!({ "windowSec": REQUEST_WINDOW.as_secs(), "clusters": out })
    }

    /// Everything the Zabbix push sends, read as a snapshot: each lock taken briefly and
    /// let go, none held across another and none across an await. Aggregates only — no
    /// cluster is named in what this returns. See `zbx_push`.
    pub(crate) fn push_figures(&self, window: std::time::Duration) -> crate::zbx_push::Figures {
        let window_ms = window.as_millis() as u64;
        let load = self.gate.load();
        let w = self.gate.window(window_ms);
        let sent: usize = self.sent_counts(window).iter().map(|(_, n)| n).sum();
        let cfg = self.req_cfg.read().clone();
        let (_, read_cache_used) = self.read_cache.usage();
        let (policy_mode, paused_all, paused_clusters) = {
            let pol = self.fleet.policy.read();
            (pol.mode.as_str(), pol.paused.all, pol.paused.clusters.len())
        };
        let (cache_used, cache_budget) = {
            let budget = self.fleet.cfg.read().cache_bytes as u64;
            (self.fleet.state.lock().total_cost() as u64, budget)
        };
        crate::zbx_push::Figures {
            clock: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            load,
            window: w,
            sent,
            global_limit: cfg.limits.global,
            queue_max: cfg.limits.queue_max,
            queue_wait_ms: cfg.limits.queue_wait_ms,
            policy_mode,
            paused_all,
            paused_clusters,
            cache_used_bytes: cache_used,
            cache_budget_bytes: cache_budget,
            inflight_used_bytes: self.body_budget.in_use_bytes(),
            inflight_budget_bytes: self.body_budget.total_bytes(),
            read_cache_used_bytes: read_cache_used,
            read_cache_budget_bytes: cfg.read_cache_bytes,
            memory_limit_bytes: crate::memory::budget().limit_bytes,
            clusters: self.all_specs().len(),
        }
    }

    /// The clusters configured now, for housekeeping to tell a removed cluster from one that
    /// is merely not known yet. `Err` says why the list cannot be believed: nothing is
    /// primed (a restart before an admin's page primes the desktop app, or the hosted core
    /// before it restores its setup), or Zabbix is configured and its hosts have not been
    /// read once — treating either as "every cluster was removed" would empty the cache.
    pub(crate) fn housekeeping_known_clusters(&self) -> Result<std::collections::HashSet<String>, String> {
        let ids: std::collections::HashSet<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        if ids.is_empty() {
            return Err("no clusters are configured yet, so none can be called removed".into());
        }
        if self.edition == Edition::Hosted && self.zbx_api().configured() && self.zbx_sync.read().last_ok.is_none() {
            return Err("the Zabbix cluster list has not been read yet".into());
        }
        Ok(ids)
    }

    /// The stores housekeeping tidies, for `housekeeping.rs`, which cannot see this struct's
    /// private fields.
    pub(crate) fn housekeeping_stores(&self) -> crate::housekeeping::Stores<'_> {
        crate::housekeeping::Stores {
            tokens: &self.tokens,
            notify: &self.notify,
            silences: &self.silences,
            activity: &self.activity,
        }
    }

    /// Housekeeping for the maps that grow with the clusters seen, the people who asked and
    /// the minutes gone by. `known` is the clusters configured now — `None` when that is not
    /// settled yet, in which case only what has expired by time goes. Returns what went (or
    /// would, on a dry run), by name.
    pub(crate) fn housekeep_memory(&self, known: Option<&std::collections::HashSet<String>>, dry_run: bool) -> Vec<(&'static str, usize)> {
        let now = crate::fleet::now_ms();
        let mut out: Vec<(&'static str, usize)> = vec![];
        let empty = std::collections::HashSet::new();
        let keep = known.unwrap_or(&empty);

        // Request counters: a cluster that was removed, or whose last request is older than
        // the reporting window, reports nothing and need not be remembered.
        {
            let mut log = self.request_log.lock();
            let t = std::time::Instant::now();
            let stale = |c: &String, q: &std::collections::VecDeque<std::time::Instant>|
                known.is_some_and(|k| !k.contains(c)) || q.back().is_none_or(|x| t.duration_since(*x) > REQUEST_WINDOW);
            let n = log.iter().filter(|(c, q)| stale(c, q)).count();
            if !dry_run {
                log.retain(|c, q| !stale(c, q));
            }
            out.push(("request counters", n));
        }
        // The gate's own per-cluster and per-jump-host counts remove themselves at zero, and
        // a shared request leaves the flight table when it ends; what can outlive a removed
        // cluster is the read cache and the reaper's list of abandoned reads.
        {
            // Without a settled cluster list every cluster looks unknown; keep them all.
            let n = if known.is_some() { self.read_cache.prune_clusters(keep, dry_run) } else { 0 };
            out.push(("read cache entries", n));
        }
        {
            let mut log = self.requests.lock();
            let n = if known.is_some() { log.abandoned.keys().filter(|c| !keep.contains(*c)).count() } else { 0 };
            if n > 0 && !dry_run {
                log.abandoned.retain(|c, _| keep.contains(c));
            }
            out.push(("abandoned-read marks", n));
        }
        {
            let n = if known.is_some() { self.transport.prune_clients(keep, dry_run) } else { 0 };
            out.push(("connection clients", n));
        }
        {
            let mut c = self.zbx_metrics_cache.lock();
            let ttl = std::time::Duration::from_secs(120);
            let n = c.values().filter(|(at, _)| at.elapsed() >= ttl).count();
            if !dry_run {
                c.retain(|_, (at, _)| at.elapsed() < ttl);
            }
            out.push(("Zabbix metric cache entries", n));
        }
        out.push(("Zabbix sign-in nonces and codes", self.zbx.sweep_expired(dry_run)));
        out.push(("Zabbix link budgets", self.zbx_link.sweep_expired(dry_run)));
        let (st, tickets) = self.fleet.sweep_memory(known, now, dry_run);
        out.push(("poller throttles", st.throttles));
        out.push(("poller request windows", st.budget_windows));
        out.push(("poller watch marks", st.watched));
        out.push(("poller refresh limiters", st.refresh_limits));
        out.push(("poller idle counters", st.running_counters));
        out.push(("event-stream tickets", tickets));
        out
    }

    /// Whether this caller may silence (or un-silence) that target: the cluster that owns it,
    /// resolved among every known cluster id (silences::cluster_of), must be one they see.
    fn silence_allowed(&self, caller: Option<&Caller>, scope: &str, target: &str) -> bool {
        let known: Vec<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        let visible: std::collections::HashSet<String> = self.fleet_visible(caller).into_iter().collect();
        crate::silences::cluster_of(scope, target, &known).is_some_and(|id| visible.contains(id))
    }

    /// The live silences this caller may see.
    fn silences_visible(&self, caller: Option<&Caller>) -> Vec<crate::silences::Silence> {
        self.silences.list().into_iter().filter(|s| self.silence_allowed(caller, &s.scope, &s.target)).collect()
    }

    pub fn writes_unlocked(&self) -> bool {
        self.writes_unlocked.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn set_writes_unlocked(&self, on: bool) {
        self.writes_unlocked.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /* ------------------------------ accounts and tokens ----------------------------- */

    fn login(self: &Arc<Self>, msg: &Value) -> Value {
        let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let password = msg.get("password").and_then(|v| v.as_str()).unwrap_or("");
        match self.users.verify(name, password) {
            Ok(acct) => {
                let token = self.sessions.begin(&acct);
                tracing::info!(target: "audit", user = %acct.name, role = acct.role.as_str(), "login");
                self.users.record_login(&acct.name, "password", Ok(()));
                // One shape for "who is this", built from the account rather than
                // assembled by hand here and differently somewhere else.
                let who = Caller { name: acct.name.clone(), role: acct.role, must_change: acct.must_change, scope: acct.scope.clone() };
                json!({ "ok": true, "session": token, "caller": who.public() })
            }
            Err(e) => {
                // The name is logged. Locked and blocked are told only to someone who typed
                // the right password (UserStore::verify); otherwise it is "do not match",
                // so a failed login never confirms which half was wrong.
                tracing::warn!(target: "audit", user = %name, reason = e.kind(), "login refused");
                self.users.record_login(name, "password", Err(&e));
                json!({ "ok": false, "kind": e.kind(), "message": e.to_string() })
            }
        }
    }

    /// The first administrator. Only possible while no account exists at all, which is
    /// what stops this being a way to add one later.
    fn bootstrap_admin(self: &Arc<Self>, msg: &Value) -> Value {
        if !self.users.is_empty() {
            return json!({
                "ok": false, "kind": "forbidden",
                "message": "accounts already exist — an administrator must create further accounts",
            });
        }
        let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let password = msg.get("password").and_then(|v| v.as_str()).unwrap_or("");
        match self.users.add(name, password, Role::Admin) {
            Ok(()) => {
                tracing::info!(target: "audit", user = %name, "first administrator created");
                // Signed straight in: making someone type the password they just chose
                // adds nothing.
                match self.users.verify(name, password) {
                    Ok(acct) => {
                        let token = self.sessions.begin(&acct);
                        let who = Caller { name: acct.name.clone(), role: acct.role, must_change: acct.must_change, scope: None };
                        json!({ "ok": true, "session": token, "caller": who.public() })
                    }
                    Err(e) => json!({ "ok": false, "message": e.to_string() }),
                }
            }
            Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e.to_string() }),
        }
    }

    fn users_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        // Portable has no accounts, so it has no empty list of them either. Answering
        // `users: []` would be a claim about the deployment — "nobody has access here" —
        // when the truth is a claim about the build. The UI already hides the page; this
        // is for anything else that asks, which until now was told a plausible lie.
        if !self.edition.uses_accounts() {
            return json!({
                "ok": false, "kind": "unsupported", "supported": false,
                "message": "this build has no accounts: everything beside the exe, no install, \
                            nobody to sign in as. Use the installed or hosted build for accounts.",
            });
        }
        let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let me = caller.map(|c| c.name.clone()).unwrap_or_default();
        let role_arg = || {
            msg.get("role")
                .and_then(|v| v.as_str())
                .and_then(Role::parse)
                .ok_or_else(|| "role must be admin, operator, user or guest".to_string())
        };
        let done = |r: Result<(), crate::auth::AuthError>| match r {
            Ok(()) => json!({ "ok": true, "users": self.users.list().iter().map(|a| a.public()).collect::<Vec<_>>() }),
            Err(e) => json!({ "ok": false, "kind": e.kind(), "message": e.to_string() }),
        };
        let flag = |k: &str| msg.get(k).and_then(|v| v.as_bool());

        match t {
            "USER_LIST" => json!({
                "ok": true,
                "users": self.users.list().iter().map(|a| a.public()).collect::<Vec<_>>(),
                "sessions": self.sessions.count(),
            }),
            "USER_ADD" => {
                let role = match role_arg() {
                    Ok(r) => r,
                    Err(m) => return json!({ "ok": false, "kind": "bad_request", "message": m }),
                };
                let password = msg.get("password").and_then(|v| v.as_str()).unwrap_or("");
                let out = done(self.users.add(&name, password, role));
                if out["ok"] == json!(true) {
                    tracing::info!(target: "audit", user = %me, subject = %name, role = role.as_str(), "account created");
                }
                out
            }
            "USER_REMOVE" => {
                // Refusing to remove yourself is not paternalism: an admin who deletes
                // their own account mid-session leaves a live session with no account
                // behind it, and possibly nobody able to fix it.
                if name.eq_ignore_ascii_case(&me) {
                    return json!({ "ok": false, "kind": "bad_request", "message": "you cannot remove the account you are signed in as" });
                }
                let out = done(self.users.remove(&name));
                if out["ok"] == json!(true) {
                    // Their sessions go with the account, or they keep working until the
                    // idle timeout on an account that no longer exists.
                    self.sessions.end_all_for(&name);
                    tracing::info!(target: "audit", user = %me, subject = %name, "account removed");
                }
                out
            }
            "USER_SET_ROLE" => {
                let role = match role_arg() {
                    Ok(r) => r,
                    Err(m) => return json!({ "ok": false, "kind": "bad_request", "message": m }),
                };
                if name.eq_ignore_ascii_case(&me) && role != Role::Admin {
                    return json!({ "ok": false, "kind": "bad_request", "message": "you cannot take away your own administrator role" });
                }
                let mut out = done(self.users.set_role(&name, role));
                if out["ok"] == json!(true) {
                    // Their open sessions take the new role now, without signing them out.
                    let acct = self.users.list().into_iter().find(|a| a.name.eq_ignore_ascii_case(&name));
                    let pinned = acct.as_ref().is_some_and(|a| a.role_pinned);
                    self.sessions.refresh_for(&name, role, acct.and_then(|a| a.scope));
                    tracing::info!(target: "audit", user = %me, subject = %name, role = role.as_str(), pinned, "role changed");
                    // Said back so the page can tell the admin the change will stick.
                    out["pinned"] = json!(pinned);
                }
                out
            }
            "USER_UNPIN_ROLE" => {
                let out = done(self.users.unpin_role(&name));
                if out["ok"] == json!(true) {
                    // Nothing changes until their next Zabbix sign-in, which is the point; the
                    // open sessions are refreshed from the account as it stands, exactly as a
                    // role change does, so a session never holds a role the account has not.
                    if let Some(a) = self.users.list().into_iter().find(|a| a.name.eq_ignore_ascii_case(&name)) {
                        self.sessions.refresh_for(&a.name, a.role, a.scope.clone());
                    }
                    tracing::info!(target: "audit", user = %me, subject = %name, "role follows zabbix again");
                }
                out
            }
            "USER_SET_LOCKED" | "USER_SET_BLOCKED" => {
                let Some(on) = flag(if t == "USER_SET_LOCKED" { "locked" } else { "blocked" }) else {
                    return json!({ "ok": false, "kind": "bad_request", "message": "say true or false" });
                };
                if on && name.eq_ignore_ascii_case(&me) {
                    return json!({ "ok": false, "kind": "bad_request", "message": "you cannot lock or block the account you are signed in as" });
                }
                let (r, what) = if t == "USER_SET_LOCKED" {
                    (self.users.set_locked(&name, on), if on { "account locked" } else { "account unlocked" })
                } else {
                    (self.users.set_disabled(&name, on), if on { "account blocked" } else { "account unblocked" })
                };
                let out = done(r);
                if out["ok"] == json!(true) {
                    tracing::info!(target: "audit", user = %me, subject = %name, "{what}");
                }
                out
            }
            "USER_LOGINS" => json!({
                "ok": true,
                "logins": self.users.logins(),
                "lockAfter": crate::auth::LOCK_AFTER,
                "lockMinutes": crate::auth::LOCK_SECS / 60,
            }),
            "USER_SET_PASSWORD" => {
                // Otherwise the forced change could be satisfied by changing somebody
                // else's password and leaving the shipped one in place.
                if caller.is_some_and(|c| c.must_change) && !name.eq_ignore_ascii_case(&me) {
                    return json!({ "ok": false, "kind": "bad_request",
                                   "message": "set your own password first" });
                }
                let password = msg.get("password").and_then(|v| v.as_str()).unwrap_or("");
                let out = done(self.users.set_password(&name, password));
                if out["ok"] == json!(true) {
                    // The session in front of us is holding the old answer.
                    self.sessions.clear_must_change(&name);
                    // Everyone but the person doing it: changing your own password should
                    // not sign you out of the screen you are standing at.
                    if !name.eq_ignore_ascii_case(&me) {
                        self.sessions.end_all_for(&name);
                    }
                    tracing::info!(target: "audit", user = %me, subject = %name, "password changed");
                }
                out
            }
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("unknown account message {t}") }),
        }
    }

    fn tokens_msg(self: &Arc<Self>, t: &str, msg: &Value) -> Value {
        if !self.edition.uses_api_tokens() {
            return json!({
                "ok": false, "kind": "unsupported",
                "message": "API tokens need a build that serves HTTP. The desktop app talks to                             this core over local IPC and has no socket to offer one on — use the                             hosted deployment for Zabbix and scripts.",
            });
        }
        match t {
            "TOKEN_LIST" => json!({ "ok": true, "tokens": self.tokens.list().iter().map(|x| x.public()).collect::<Vec<_>>() }),
            "TOKEN_CREATE" => {
                let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let role = msg.get("role").and_then(|v| v.as_str()).and_then(Role::parse).unwrap_or(Role::Guest);
                if role >= Role::Operator {
                    return json!({
                        "ok": false, "kind": "bad_request",
                        "message": "an API token cannot be an administrator — a token that can delete                                     indices unattended is the thing this product exists to avoid",
                    });
                }
                let ttl = msg.get("expiresDays").and_then(|v| v.as_u64()).map(|d| d as u32);
                match self.tokens.create(name, role, ttl) {
                    Ok(secret) => {
                        tracing::info!(target: "audit", token = %name, role = role.as_str(), "api token created");
                        json!({
                            "ok": true, "secret": secret,
                            "note": "This is the only time the token is shown. Store it now.",
                            "tokens": self.tokens.list().iter().map(|x| x.public()).collect::<Vec<_>>(),
                        })
                    }
                    Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e.to_string() }),
                }
            }
            "TOKEN_REVOKE" => {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                match self.tokens.revoke(id) {
                    Ok(()) => {
                        tracing::info!(target: "audit", token_id = %id, "api token revoked");
                        json!({ "ok": true, "tokens": self.tokens.list().iter().map(|x| x.public()).collect::<Vec<_>>() })
                    }
                    Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e.to_string() }),
                }
            }
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("unknown token message {t}") }),
        }
    }

    /* ------------------------- uploaded keys and history ------------------------- */

    fn keys_msg(self: &Arc<Self>, t: &str, msg: &Value) -> Value {
        let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "KEY_LIST" => json!({ "ok": true, "keys": self.keys.list() }),
            "KEY_UPLOAD" => {
                let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
                match self.keys.put(name, text) {
                    // The path is the point: it is what goes in the jump host's keyFile,
                    // and the operator has no other way to know where it landed.
                    Ok(info) => {
                        tracing::info!(target: "audit", key = %info.name, digest = %info.digest, "private key uploaded");
                        json!({ "ok": true, "key": info, "keys": self.keys.list() })
                    }
                    Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e }),
                }
            }
            "KEY_DELETE" => match self.keys.delete(name) {
                Ok(()) => {
                    tracing::info!(target: "audit", key = %name, "private key removed");
                    json!({ "ok": true, "keys": self.keys.list() })
                }
                Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e }),
            },
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("unknown key message {t}") }),
        }
    }

    fn history_msg(self: &Arc<Self>, t: &str, msg: &Value) -> Value {
        match t {
            "CONFIG_HISTORY" => json!({ "ok": true, "versions": self.history.list() }),
            "CONFIG_RESTORE" => {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                match self.history.read(id) {
                    // Handed back rather than written. Restoring is loading a config, and
                    // the UI already knows how to parse one, ask about its credentials and
                    // save it — going around that would be a second way to load a config
                    // that could disagree with the first.
                    Ok(text) => json!({ "ok": true, "id": id, "text": text }),
                    Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e }),
                }
            }
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("unknown history message {t}") }),
        }
    }

    /// The shell's handshake, and — once there is somebody to tell — the fleet's state.
    ///
    /// PING has to answer before anyone signs in, because the shell cannot know whether a
    /// sign-in is needed until it asks. That makes the first half of this payload the one
    /// thing a stranger who can reach the port is guaranteed to see, so it carries facts
    /// about the build and about whether authentication is on, and nothing that names
    /// anything.
    ///
    /// The second half names plenty: the clusters, where the config lives, how much
    /// traffic we are sending and which jump hosts are up. A configured hosted instance
    /// handed all of it to a bare curl for a while — the cluster list, the config path
    /// and the request rates, with no credential at all — because this was one flat
    /// object and PING was exempt from the gate. It is two halves now.
    ///
    /// The split is on `uses_accounts`, not on `caller.is_none()`: the portable build has
    /// no accounts and no caller ever, and must still see all of it.
    /// NOTIFY_PUT / NOTIFY_LIST / NOTIFY_CLEAR, always on the caller's own history.
    ///
    /// The user is never read from the message. Portable has no accounts and one person,
    /// who is "local"; every other edition has passed the gate with a caller by now, and a
    /// missing one is refused the way the gate would refuse it.
    fn notify_msg(&self, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        let user = match caller {
            Some(c) => c.name.clone(),
            None if !self.edition.uses_accounts() => "local".to_string(),
            None => return json!({ "ok": false, "kind": "unauthenticated", "message": "sign in to continue" }),
        };
        let num = |k: &str| msg.get(k).and_then(|v| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)));
        match t {
            "NOTIFY_PUT" => match self.notify.put(&user, msg) {
                Ok(id) => json!({ "ok": true, "id": id }),
                Err(why) => json!({ "ok": false, "kind": "bad_message", "message": why }),
            },
            "NOTIFY_LIST" => {
                let limit = num("limit").map(|n| n as usize).unwrap_or(crate::notify::LIST_DEFAULT);
                // The same scope the fleet messages use: a Zabbix group change that takes a
                // cluster away takes its notices with it.
                let visible = self.visible_ids(caller);
                let (items, more) = self.notify.list(&user, num("since"), num("before"), limit, visible.as_ref());
                json!({
                    "ok": true,
                    "items": items.iter().map(|r| r.public()).collect::<Vec<_>>(),
                    "more": more,
                    "days": self.notify.days(),
                })
            }
            "NOTIFY_CLEAR" => json!({ "ok": true, "removed": self.notify.clear(&user) }),
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("unknown notification message {t}") }),
        }
    }

    /// Write out the notification history now rather than after its debounce.
    pub fn flush_notifications(&self) {
        self.notify.flush();
    }

    async fn ping(self: &Arc<Self>, caller: Option<&Caller>) -> Value {
        let mut out = json!({
            "ok": true,
            "version": crate::VERSION,
            "desktop": true,
            "netErrors": true,
            "vault": cfg!(feature = "vault"),
            "edition": self.edition,
            "authRequired": self.edition.uses_accounts(),
            "needsBootstrap": self.needs_bootstrap(),
            "apiTokens": self.edition.uses_api_tokens(),
            // The UI reads fleet state from the core's cache when this is true, and asks
            // each cluster itself when it is not (an older core, or a snapshot).
            "fleetCache": self.fleet_enabled(),
            // The bell keeps its history here as well as in the browser when this is true.
            "notifyStore": true,
            "notifyDays": self.notify.days(),
            // Config → Zabbix can set up the connection (admins; ZABBIX_LINK_GET).
            "zabbixLink": self.edition == Edition::Hosted,
        });
        if self.edition.uses_accounts() && caller.is_none() {
            return out;
        }

        let visible = self.visible_ids(caller);
        let (primed, read_only, ids) = {
            let all = self.all_specs();
            let ids = all.iter().map(|s| s.id.clone()).filter(|k| visible.as_ref().is_none_or(|v| v.contains(k))).collect::<Vec<_>>();
            (!all.is_empty(), self.primed.read().read_only, ids)
        };
        let tunnels = self.tunnels_for(caller).await;
        // Where files live on the server is an administrator's business. Portable has no
        // caller and is its own administrator.
        let admin = caller.is_none_or(|c| c.role >= Role::Admin);
        let m = out.as_object_mut().expect("the ping payload is a json object");
        m.insert("primed".into(), json!(primed));
        m.insert("readOnly".into(), json!(read_only));
        m.insert("writesUnlocked".into(), json!(self.writes_unlocked()));
        m.insert("requests".into(), self.requests_for(caller));
        m.insert("clusters".into(), json!(ids));
        m.insert("dataDir".into(), if admin { json!(self.data_dir) } else { Value::Null });
        m.insert("configHint".into(), if admin { json!(self.config_hint) } else { Value::Null });
        m.insert("uptimeSec".into(), json!(self.started.elapsed().as_secs()));
        m.insert("defaultConfigPath".into(), if admin { json!(self.server_config_path()) } else { Value::Null });
        m.insert("tunnels".into(), json!(tunnels));
        m.insert("zabbixSso".into(), json!(self.zbx.configured()));
        // What config.txt manages. The UI applies it last and shows it read-only; not secret,
        // so every signed-in caller gets it.
        let managed = crate::settings::get();
        m.insert("managedDefaults".into(), managed.ping_defaults());
        m.insert("managedZabbixOptions".into(), managed.ping_zabbix_options());
        out
    }

    /// Jump hosts, less those that carry none of this caller's clusters.
    async fn tunnels_for(&self, caller: Option<&Caller>) -> Vec<Value> {
        let all = self.tunnel_status().await;
        let Some(ids) = self.visible_ids(caller) else { return all };
        let vias: std::collections::HashSet<String> =
            self.all_specs().into_iter().filter(|s| ids.contains(&s.id)).filter_map(|s| s.via).collect();
        all.into_iter().filter(|t| t["id"].as_str().is_some_and(|id| vias.contains(id))).collect()
    }

    fn requests_for(&self, caller: Option<&Caller>) -> Value {
        let mut all = self.request_stats();
        if let (Some(ids), Some(m)) = (self.visible_ids(caller), all.as_object_mut()) {
            m.retain(|k, _| ids.contains(k));
        }
        all
    }

    /// The Request Centre's answer: what is in flight and what finished recently, for the
    /// clusters this caller may see. `cluster` narrows to one; `limit` caps the finished list
    /// (newest first; default 200).
    fn request_log_for(&self, caller: Option<&Caller>, msg: &Value) -> Value {
        let ids = self.visible_ids(caller);
        let only = msg.get("cluster").and_then(|c| c.as_str()).filter(|c| !c.is_empty()).map(String::from);
        let limit = msg.get("limit").and_then(|l| l.as_u64()).unwrap_or(200).min(REQUEST_LOG_KEEP as u64) as usize;
        let sees = |r: &RequestRecord| ids.as_ref().is_none_or(|s| s.contains(&r.cluster)) && only.as_ref().is_none_or(|c| c == &r.cluster);
        // Copied out and the lock let go before anything else is locked or serialised: every
        // request going to a cluster takes this lock, and nothing may be held while it waits.
        let (mut inflight, recent): (Vec<RequestRecord>, Vec<RequestRecord>) = {
            let log = self.requests.lock();
            (log.inflight.values().filter(|r| sees(r)).cloned().collect(),
             log.recent.iter().rev().filter(|r| sees(r)).take(limit).cloned().collect())
        };
        inflight.sort_by_key(|r| r.started_at);
        let now = crate::fleet::now_ms();
        let throttled: serde_json::Map<String, Value> = {
            let st = self.fleet.state.lock();
            st.throttle.iter().filter(|(c, t)| t.until > now && ids.as_ref().is_none_or(|v: &std::collections::HashSet<String>| v.contains(*c)))
                .map(|(c, t)| (c.clone(), serde_json::to_value(t).unwrap_or(Value::Null))).collect()
        };
        let cfg = self.req_cfg.read().clone();
        let (entries, bytes) = self.read_cache.usage();
        let mut gate = self.gate.report(ids.as_ref());
        if let Some(m) = gate.as_object_mut() {
            m.insert("limits".into(), json!(cfg.limits));
            m.insert("readCache".into(), json!({ "seconds": cfg.read_cache_secs, "maxBytes": cfg.read_cache_bytes, "entries": entries, "bytes": bytes }));
            m.insert("maxResponseBytes".into(), json!(cfg.max_response_bytes));
            m.insert("maxFleetResponseBytes".into(), json!(cfg.max_fleet_response_bytes));
            m.insert("bodyBudget".into(), json!({ "limitBytes": self.body_budget.total_bytes(), "inUseBytes": self.body_budget.in_use_bytes() }));
            m.insert("flights".into(), json!(self.flights.len()));
            m.insert("taskReaper".into(), json!({ "mode": cfg.task_reaper.as_str(), "maxSeconds": cfg.task_max_secs, "last": *self.task_reaper_last.lock() }));
            // Whether these figures reach Zabbix (ZABBIX_METRICS_HOST). The last error can
            // name the Zabbix address, so it is for an admin who sees every cluster.
            let mut push = serde_json::to_value(&*self.zbx_push.lock()).unwrap_or(Value::Null);
            if ids.is_some() {
                if let Some(p) = push.as_object_mut() {
                    p.remove("lastError");
                }
            }
            m.insert("zabbixPush".into(), push);
        }
        json!({
            "ok": true, "inflight": inflight, "recent": recent, "keep": REQUEST_LOG_KEEP, "throttled": throttled,
            "gate": gate,
            // The Tasks panel reads its listing and how to recognise ours from here, so the
            // two are defined once (tasks.rs).
            "tasks": { "path": crate::tasks::TASKS_PATH, "prefix": crate::tasks::OPAQUE_PREFIX,
                       "instance": self.instance, "previousInstance": self.previous_instance },
        })
    }

    /// Trust decisions, less the hosts that belong to clusters this caller cannot see.
    fn pins_for(&self, caller: Option<&Caller>) -> Value {
        let mut all = self.pins.list();
        let visible = self.visible_ids(caller);
        if let Some(m) = all.as_object_mut() {
            m.insert("acceptAll".into(), json!(self.pins.accept_all()));
            m.insert("accepted".into(), json!(self.accepted_for(visible.as_ref())));
        }
        let Some(ids) = visible else { return all };
        let (hosts, vias): (std::collections::HashSet<String>, std::collections::HashSet<String>) = {
            let all = self.all_specs();
            let mine: Vec<&ClusterSpec> = all.iter().filter(|s| ids.contains(&s.id)).collect();
            (mine.iter().filter_map(|s| host_port(&s.url)).flat_map(|(h, hp)| [h, hp]).collect(),
             mine.iter().filter_map(|s| s.via.clone()).collect())
        };
        if let Some(m) = all.as_object_mut() {
            m.remove("path");
            if let Some(Value::Object(certs)) = m.get_mut("certs") {
                certs.retain(|k, _| hosts.contains(k));
            }
            if let Some(Value::Object(keys)) = m.get_mut("hostkeys") {
                keys.retain(|k, _| vias.contains(k));
            }
        }
        all
    }

    /// What the accept-all switch let through, each with the clusters it serves. A caller
    /// limited to some clusters sees only those; what serves none of them (the Zabbix API's
    /// certificate, a jump host they do not route through) is for unscoped callers only.
    fn accepted_for(&self, visible: Option<&std::collections::HashSet<String>>) -> Vec<Value> {
        let specs = self.all_specs();
        self.pins.accepted().into_iter().filter_map(|a| {
            let serves: Vec<Value> = specs.iter()
                .filter(|s| visible.is_none_or(|v| v.contains(&s.id)))
                .filter(|s| if a.kind == "host_key" { s.via.as_deref() == Some(a.target.as_str()) }
                            else { crate::http::host_key(&s.url) == a.target })
                .map(|s| json!({ "id": s.id, "name": s.name.clone().unwrap_or_else(|| s.id.clone()) }))
                .collect();
            if serves.is_empty() && visible.is_some() {
                return None;
            }
            Some(json!({ "kind": a.kind, "target": a.target, "fingerprint": a.fingerprint, "subject": a.subject,
                         "reason": a.reason, "firstSeen": a.first_seen, "clusters": serves }))
        }).collect()
    }

    /// The cluster list for somebody who may not read the config file: credentials
    /// removed, and only the clusters they may see.
    ///
    /// Read from the file the hosted core was started with — never from a path the caller
    /// names, which would make this a way to read any file the core can.
    /// The server's own config file, parsed — YAML or JSON, decided by content. The error is
    /// a ready refusal. Read from the path the core was started with and no other.
    /// Where a new config is created: the server's own file (ELASTICPRO_CONFIG) when it has
    /// one, so the file an admin builds is the file everybody else is served; the data
    /// directory only when there is no such file. Creating it in the data directory while
    /// ELASTICPRO_CONFIG named another place was an admin with thirty clusters and every
    /// operator with none — CONFIG_VIEW read the one, the admin had written the other.
    fn server_config_path(&self) -> Option<std::path::PathBuf> {
        self.config_hint.clone().map(std::path::PathBuf::from).or_else(|| self.data_dir.as_ref().map(|d| d.join("config_cluster.json")))
    }

    /// The config written by older versions to the data directory while ELASTICPRO_CONFIG
    /// named another file. Read when that file is missing or lists no cluster, so an
    /// install made before the fix keeps serving its non-admins without anyone moving it.
    fn stray_config_path(&self) -> Option<std::path::PathBuf> {
        let stray = self.data_dir.as_ref()?.join("config_cluster.json");
        (self.config_hint.as_deref().map(std::path::Path::new) != Some(stray.as_path()) && stray.is_file()).then_some(stray)
    }

    async fn read_config_file(&self) -> Result<Value, Value> {
        self.locate_config().await.map(|c| c.raw)
    }

    /// The server's config file as it was found: where, its text and what it parses to.
    /// The named file (ELASTICPRO_CONFIG), unless it lists no cluster and the stray one
    /// from an older install does — then that one, so a save from here goes back where the
    /// clusters were read from.
    async fn locate_config(&self) -> Result<LocatedConfig, Value> {
        let Some(hint) = self.config_hint.clone() else {
            return Err(json!({ "ok": false, "kind": "no_config",
                               "message": "this server was started without a config file (ELASTICPRO_CONFIG)" }));
        };
        match self.read_config_at(std::path::Path::new(&hint)).await {
            Ok(c) if config_has_clusters(&c.raw) => Ok(c),
            first => match self.stray_config_path() {
                Some(stray) => match self.read_config_at(&stray).await {
                    Ok(c) if config_has_clusters(&c.raw) => Ok(c),
                    _ => first,
                },
                None => first,
            },
        }
    }

    async fn read_config_at(&self, path: &std::path::Path) -> Result<LocatedConfig, Value> {
        let text = match tokio::fs::read_to_string(path).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(json!({ "ok": false, "kind": "not_found",
                                   "message": "no clusters are configured yet — an admin has to add one first" }))
            }
            Err(e) => return Err(json!({ "ok": false, "kind": "io_error", "message": format!("cannot read the config: {e}") })),
        };
        let raw = parse_config_text(&text).map_err(|e| json!({ "ok": false, "kind": "parse_error", "message": format!("the config does not parse: {e}") }))?;
        let yaml = !text.trim_start_matches('\u{feff}').trim_start().starts_with('{');
        Ok(LocatedConfig { path: path.to_path_buf(), yaml, raw })
    }

    /// Write a changed config back where it was read from, keeping the version before it.
    async fn store_config(&self, found: &LocatedConfig) -> Result<bool, Value> {
        let kept = self.history.snapshot(&found.path);
        write_text_atomic(&found.path, &serialize_config(&found.raw, found.yaml)).await
            .map_err(|message| json!({ "ok": false, "kind": "io_error", "message": message }))?;
        Ok(kept)
    }

    /// `CLUSTER_SAVE`: one cluster added, changed or switched off by an operator (or an
    /// admin using the same door). The rule is `cluster_save::apply`; this is the file
    /// around it, and then the fleet: the saved cluster is polled from now on, with the
    /// credential the core already holds for it, the shared one, or none until an admin
    /// signs in once — the reply says which.
    async fn cluster_save(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(incoming) = msg.get("cluster") else {
            return json!({ "ok": false, "kind": "bad_message", "message": "CLUSTER_SAVE needs a cluster" });
        };
        let replace = msg.get("replace").and_then(|v| v.as_str());
        let mut found = match self.locate_config().await {
            Ok(c) => c,
            Err(refusal) => return refusal,
        };
        let sees = |c: &Value| caller.is_none_or(|who| who.sees(&raw_groups(c)));
        let who = caller.map(|c| c.name.as_str()).unwrap_or("-");
        let saved = match crate::cluster_save::apply(&mut found.raw, incoming, replace, &sees) {
            Ok(s) => s,
            Err(r) => {
                tracing::warn!(target: "audit", user = %who, kind = r.kind, reason = %r.message, "cluster save refused");
                return r.to_json();
            }
        };
        let kept = match self.store_config(&found).await {
            Ok(k) => k,
            Err(refusal) => return refusal,
        };
        let credential = self.adopt_saved_cluster(&saved, &found.raw).await;
        tracing::info!(target: "audit", user = %who, cluster = %saved.name, was = ?saved.was, action = saved.action,
                       credential, "cluster saved");
        json!({ "ok": true, "action": saved.action, "name": saved.name, "was": saved.was, "keptVersion": kept, "credential": credential })
    }

    /// `AUTOMATIONS_SAVE`: the config's `automations:` list, replaced by an operator's. The
    /// rules are read by the browser (core/user-rules.js); the core only keeps them.
    async fn automations_save(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(list) = msg.get("automations") else {
            return json!({ "ok": false, "kind": "bad_message", "message": "AUTOMATIONS_SAVE needs an automations list" });
        };
        let mut found = match self.locate_config().await {
            Ok(c) => c,
            Err(refusal) => return refusal,
        };
        let who = caller.map(|c| c.name.as_str()).unwrap_or("-");
        let count = match crate::cluster_save::apply_automations(&mut found.raw, list) {
            Ok(n) => n,
            Err(r) => {
                tracing::warn!(target: "audit", user = %who, kind = r.kind, reason = %r.message, "automations save refused");
                return r.to_json();
            }
        };
        let kept = match self.store_config(&found).await {
            Ok(k) => k,
            Err(refusal) => return refusal,
        };
        tracing::info!(target: "audit", user = %who, count, "automations saved");
        json!({ "ok": true, "count": count, "keptVersion": kept })
    }

    /// Make a saved cluster the fleet's business now, without waiting for an admin's PRIME.
    ///
    /// The spec is built from the entry the way the UI's `normalize()` builds one, and the
    /// credential follows PRIME's own rules: the header the core already holds for this
    /// cluster stays while its destination — address, route, certificate setting — is the
    /// same ("kept"); a cluster with no credential of its own in the file signs in with
    /// the shared one, exactly as it would after an admin's PRIME ("shared"); a cluster
    /// whose own credential is in the file and whose held header cannot follow has none
    /// until an admin signs in — the core cannot build a header from a file it must not
    /// read for this caller ("admin"). Nothing here derives a header.
    async fn adopt_saved_cluster(self: &Arc<Self>, saved: &crate::cluster_save::Saved, raw: &Value) -> &'static str {
        let entry = &saved.entry;
        let get = |k: &str| entry.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        let id = crate::cluster_save::cluster_id(&saved.name);
        // Only an edit takes over a polled entry, and only the one it was. An add whose id
        // is already polled (a Zabbix host's, say) does not displace it: apply() refused
        // every config name that would collide, so this is the fleet's entry, not ours.
        let old_id = saved.was.as_deref().map(crate::cluster_save::cluster_id);
        let url = get("url").unwrap_or_default().trim_end_matches('/').to_string();
        let via = {
            let r = crate::cluster_save::route_of(entry);
            if r.is_empty() { None } else { Some(r) }
        };
        let tls = get("tls");
        let own_cred = saved.entry.as_object().is_some_and(|m| {
            let mut probe = Value::Object(m.clone());
            redact_config(&mut probe);
            probe != *entry
        });
        let pattern = get("logIndexPattern").or_else(|| get("log_index_pattern"))
            .or_else(|| raw.get("defaults").and_then(|d| d.get("logIndexPattern")).and_then(|v| v.as_str()).map(String::from));
        let changed_address;
        let credential;
        {
            let mut p = self.primed.write();
            if old_id.is_none() && (p.clusters.contains_key(&id) || self.zbx_sync.read().specs.contains_key(&id)) {
                tracing::warn!(target: "audit", cluster = %saved.name, id = %id, "cluster saved, but the fleet already polls that id; left as it was");
                return "none";
            }
            let old = old_id.as_deref().and_then(|i| p.clusters.remove(i));
            let same_address = old.as_ref().is_some_and(|o| {
                o.url.trim_end_matches('/').eq_ignore_ascii_case(&url) && o.via == via
                    && o.tls.as_deref().map(|t| t.trim().to_ascii_lowercase()) == tls.as_deref().map(|t| t.trim().to_ascii_lowercase())
            });
            changed_address = old.is_some() && !same_address;
            let auth_header = match (&old, same_address) {
                (Some(o), true) if o.auth_header.as_deref().is_some_and(|a| !a.is_empty()) => { credential = "kept"; o.auth_header.clone() }
                _ if !own_cred => match p.shared_auth.clone() {
                    Some(h) => { credential = "shared"; Some(h) }
                    None => { credential = "none"; None }
                },
                _ => { credential = "admin"; None }
            };
            p.clusters.insert(id.clone(), ClusterSpec {
                id: id.clone(),
                name: Some(saved.name.clone()),
                url,
                auth_header,
                via,
                tls,
                zabbix_groups: raw_groups(entry),
                log_index_pattern: pattern,
            });
        }
        self.read_cache.clear();
        if changed_address {
            self.forget_connections();
        }
        self.persist_current_prime().await;
        credential
    }

    /// Write the cluster setup the core holds now to primed.json, as PRIME does — so a
    /// cluster saved by an operator is still there after a restart. Jump hosts are taken
    /// from the live tunnels, without their session secrets, as PRIME takes them from its
    /// message.
    async fn persist_current_prime(self: &Arc<Self>) {
        let (read_only, mut clusters, shared) = {
            let p = self.primed.read();
            (p.read_only, p.clusters.values().cloned().collect::<Vec<ClusterSpec>>(), p.shared_auth.clone().unwrap_or_default())
        };
        clusters.sort_by(|a, b| a.id.cmp(&b.id));
        let jumps: Vec<Value> = self.tunnels.read().await.values().map(|r| {
            let s = &r.tunnel.spec;
            json!({ "id": s.id, "host": s.host, "port": s.port, "user": s.user, "keyFile": s.key_file })
        }).collect();
        self.persist_prime(&json!({ "readOnly": read_only, "clusters": clusters, "jumpHosts": jumps, "sharedAuthHeader": shared }), true);
    }

    /// `ZABBIX_ROLEMAP_GET` / `ZABBIX_ROLEMAP_SET`: which Zabbix role signs in as which
    /// ElasticPro role. Kept in the server's config file (`zabbix.roleMap`), read at every
    /// sign-in, so a change applies to the next one; pinned accounts keep their pin.
    async fn rolemap_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        let found = self.locate_config().await;
        if t == "ZABBIX_ROLEMAP_GET" {
            let (map, file) = match &found {
                Ok(c) => (ZbxOptions::from_config(&c.raw).role_map, true),
                Err(_) => (zbx_sso::RoleMap::default(), false),
            };
            let zabbix_roles = self.zabbix_roles().await;
            return json!({ "ok": true, "roleMap": map.to_json(), "defaults": zbx_sso::RoleMap::default().to_json(),
                           "file": file, "zabbixRoles": zabbix_roles.as_ref().ok(), "zabbixError": zabbix_roles.err() });
        }
        let map = match msg.get("roleMap").map(zbx_sso::RoleMap::from_message) {
            Some(Ok(m)) => m,
            Some(Err(e)) => return json!({ "ok": false, "kind": "bad_message", "message": e }),
            None => return json!({ "ok": false, "kind": "bad_message", "message": "ZABBIX_ROLEMAP_SET needs a roleMap" }),
        };
        let mut found = match found {
            Ok(c) => c,
            Err(refusal) => return refusal,
        };
        if !found.raw.is_object() {
            return json!({ "ok": false, "kind": "parse_error", "message": "the config file is not a mapping" });
        }
        if !found.raw.get("zabbix").is_some_and(Value::is_object) {
            found.raw["zabbix"] = json!({});
        }
        found.raw["zabbix"]["roleMap"] = map.to_json();
        if let Some(z) = found.raw["zabbix"].as_object_mut() {
            z.remove("role_map");
        }
        let kept = match self.store_config(&found).await {
            Ok(k) => k,
            Err(refusal) => return refusal,
        };
        tracing::info!(target: "audit", user = %caller.map(|c| c.name.as_str()).unwrap_or("-"), map = %map.to_json(), "zabbix role map changed");
        json!({ "ok": true, "roleMap": map.to_json(), "keptVersion": kept })
    }

    /// The roles Zabbix has, for the Accounts page to offer by name. Best effort: no
    /// Zabbix, or one that does not answer, is a reason, not a failure of the page.
    async fn zabbix_roles(&self) -> Result<Vec<Value>, String> {
        let zapi = self.zbx_api();
        if !zapi.configured() {
            return Err("the Zabbix API is not paired (Config → Zabbix), so the role names cannot be listed; type them".into());
        }
        zapi.roles().await
    }

    /// The `zabbix:` options as the server's config file (`server_config_path`) says them
    /// now — the sign-in scope and the role map. Read at each Zabbix sign-in rather than
    /// taken from the last sync, so a change applies to the next sign-in, sync or not.
    /// Defaults when there is no file or it does not parse.
    fn zbx_options_now(&self) -> ZbxOptions {
        let read = |p: &std::path::Path| std::fs::read_to_string(p).ok().and_then(|t| parse_config_text(&t).ok());
        let primary = self.server_config_path().as_deref().and_then(read);
        let raw = match primary {
            Some(v) if config_has_clusters(&v) => Some(v),
            other => self.stray_config_path().as_deref().and_then(read).filter(config_has_clusters).or(other),
        };
        // No file is still a config: config.txt may manage the option on its own.
        ZbxOptions::from_config(&raw.unwrap_or(Value::Null))
    }

    /// Reads `defaults.tls` from the server's own config file and sets the accept-all
    /// switch from it — never from a request, so only whoever can edit that file (an admin,
    /// on the Config page) turns certificate checking off. Fails closed: a file that is
    /// missing, unreadable or does not parse turns checking back on. No configured file at
    /// all leaves it to PRIME (desktop).
    pub(crate) async fn refresh_trust_switch(&self) {
        if self.config_hint.is_none() {
            return;
        }
        // config.txt's UI_TLS wins over the file's `defaults.tls`.
        let on = match crate::settings::get().text("UI_TLS") {
            Some(tls) => tls == "insecure",
            None => self.read_config_file().await.map(|raw| accepts_all_certificates(&raw)).unwrap_or(false),
        };
        if self.pins.set_accept_all(on) {
            self.forget_connections();
            tracing::warn!(target: "audit", on, "defaults.tls: insecure is {} — certificates and jump-host keys {}",
                           if on { "on" } else { "off" }, if on { "are accepted without checking" } else { "are checked again" });
        }
    }

    /// The `zabbix:` options, as the file says now. Defaults when there is no file.
    async fn zbx_options(&self) -> ZbxOptions {
        self.read_config_file().await.map(|raw| ZbxOptions::from_config(&raw)).unwrap_or_else(|_| ZbxOptions::from_config(&Value::Null))
    }

    async fn config_view(&self, caller: Option<&Caller>) -> Value {
        let mut raw = match self.read_config_file().await {
            Ok(v) => v,
            Err(refusal) => return refusal,
        };
        let scoped = caller.and_then(|c| c.scope.as_ref()).is_some();
        let key = if raw.get("clusters").is_some() { "clusters" } else { "hosts" };
        let mut used_vias = std::collections::HashSet::new();
        if let Some(Value::Array(list)) = raw.get_mut(key) {
            let kept: Vec<Value> = std::mem::take(list)
                .into_iter()
                .enumerate()
                .filter(|(_, c)| caller.is_none_or(|who| who.sees(&raw_groups(c))))
                .map(|(i, mut c)| {
                    // The position in the full list, so a name that collides with another
                    // cluster's gets the same id here as in the admin's view.
                    if let Some(m) = c.as_object_mut() {
                        m.insert("_index".into(), json!(i));
                        for k in ["via", "jump", "jumpHost", "jump_host"] {
                            if let Some(v) = m.get(k).and_then(|v| v.as_str()) {
                                used_vias.insert(v.to_string());
                            }
                        }
                    }
                    c
                })
                .collect();
            *list = kept;
        }
        if scoped {
            // Jump hosts carrying nobody's clusters but other people's are other people's.
            for k in ["jump_hosts", "jumpHosts", "jumps"] {
                match raw.get_mut(k) {
                    Some(Value::Object(m)) => m.retain(|id, _| used_vias.contains(id)),
                    Some(Value::Array(a)) => a.retain(|j| {
                        j.get("id").or_else(|| j.get("name")).and_then(|v| v.as_str()).is_some_and(|id| used_vias.contains(id))
                    }),
                    _ => {}
                }
            }
        }
        redact_config(&mut raw);
        let count = raw.get(key).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        json!({ "ok": true, "text": serde_json::to_string_pretty(&raw).unwrap_or_default(),
                "scoped": scoped, "clusters": count })
    }

    /// A one-time code from a Zabbix sign-in, traded for a session.
    fn sso_exchange(&self, msg: &Value) -> Value {
        let code = msg.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let refused = json!({ "ok": false, "kind": "bad_credentials",
                              "message": "that sign-in link has expired or was already used — open ElasticPro from Zabbix again" });
        let Some(name) = self.zbx.redeem(code) else { return refused };
        let Some(acct) = self.users.list().into_iter().find(|a| a.name == name && !a.disabled) else { return refused };
        // The frame keeps this token in page memory, so a reload orphans it: marked, so
        // housekeeping can tell it from a session somebody will come back to.
        let token = self.sessions.begin_frame(&acct);
        tracing::info!(target: "audit", user = %acct.name, role = acct.role.as_str(), "login via zabbix");
        let who = Caller { name: acct.name.clone(), role: acct.role, must_change: false, scope: acct.scope.clone() };
        json!({ "ok": true, "session": token, "caller": who.public() })
    }

    /// `POST /sso/zabbix`: verify a signed request from the Zabbix module and mint a code.
    ///
    /// Returns an HTTP status alongside the body. The route is for a server, not a
    /// person, so the reasons are specific: somebody configuring the module needs to know
    /// whether it was the secret or the clock.
    pub fn zabbix_sso_init(&self, body: &[u8], signature: &str) -> (u16, Value) {
        self.zabbix_sso_init_from(body, signature, None)
    }

    /// `zabbix_sso_init`, told where the request came from: `allowedSources`, when set,
    /// is applied before anything else, and each source has a request budget.
    pub fn zabbix_sso_init_from(&self, body: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> (u16, Value) {
        let (status, mut out) = self.zabbix_sso_mint(body, signature, source);
        crate::errors::stamp(&mut out);
        (status, out)
    }

    fn zabbix_sso_mint(&self, body: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> (u16, Value) {
        if self.edition != Edition::Hosted {
            return (404, json!({ "ok": false, "message": "not available in this build" }));
        }
        if !self.zbx_link.source_ok(source) {
            let s = source.map(|s| s.to_string()).unwrap_or_else(|| "unknown".into());
            tracing::warn!(target: "audit", source = %s, "zabbix sign-in refused: source not in allowedSources");
            return (403, json!({ "ok": false, "kind": "forbidden", "message": "this source may not sign in through Zabbix" }));
        }
        // The Zabbix frontend named in allowedSources is the administrator's own: not counted.
        if !self.zbx_link.trusted_source(source) && !self.zbx_link.rate_ok("sso", source, crate::zbx_link::SSO_PER_MIN) {
            tracing::warn!(target: "audit", source = ?source, "zabbix sign-in refused: rate limited");
            return (429, json!({ "ok": false, "kind": "rate_limited", "message": "too many sign-in requests — wait a minute" }));
        }
        let claim = match self.zbx.verify(body, signature, auth::now()) {
            Ok(c) => c,
            Err(e) => {
                let (status, kind) = match &e {
                    zbx_sso::SsoError::NotConfigured => (503, "not_configured"),
                    zbx_sso::SsoError::BadSignature => (401, "bad_signature"),
                    zbx_sso::SsoError::Stale => (401, "stale"),
                    zbx_sso::SsoError::Replayed => (401, "replayed"),
                    zbx_sso::SsoError::BadBody(_) => (400, "bad_request"),
                    zbx_sso::SsoError::NoRole(_) => (403, "no_role"),
                };
                tracing::warn!(target: "audit", reason = %e, "zabbix sign-in refused");
                return (status, json!({ "ok": false, "kind": kind, "message": e.to_string() }));
            }
        };
        let opts = self.zbx_options_now();
        let Some(role) = opts.role_map.resolve(claim.zabbix_role.as_deref(), claim.zabbix_user_type) else {
            let e = zbx_sso::SsoError::NoRole(zbx_sso::RoleMap::describe(claim.zabbix_role.as_deref(), claim.zabbix_user_type));
            tracing::warn!(target: "audit", user = %claim.username, reason = %e, "zabbix sign-in refused");
            return (403, json!({ "ok": false, "kind": "no_role", "message": e.to_string() }));
        };
        let scope = zbx_sso::scope_for(role, &claim.groups, opts.scope_users_by_group);
        let name = zbx_sso::account_name(&claim.username);
        let result = self.users.upsert_external(&name, zbx_sso::SOURCE, role, scope.clone());
        self.users.record_login(&name, "zabbix", result.as_ref().map(|_| ()));
        match result {
            Ok(acct) => {
                // A session already open under this name keeps the role it started with
                // unless it is told; Zabbix having just said otherwise is the telling.
                self.sessions.refresh_for(&acct.name, acct.role, acct.scope.clone());
                let code = self.zbx.issue_code(&acct.name);
                tracing::info!(target: "audit", user = %acct.name, role = acct.role.as_str(),
                               zabbix_role = ?claim.zabbix_role, zabbix_user_type = claim.zabbix_user_type,
                               groups = ?claim.groups, "zabbix sign-in code issued");
                (200, json!({ "ok": true, "sso_code": code, "account": acct.name, "role": acct.role.as_str(),
                              "scoped": acct.scope.is_some() }))
            }
            Err(auth::AuthError::Exists(n)) => {
                tracing::warn!(target: "audit", user = %n, "zabbix sign-in refused: a local account has that name");
                (409, json!({ "ok": false, "kind": "name_taken",
                              "message": format!("a local ElasticPro account is already called {n}; it will not be taken over by a Zabbix sign-in") }))
            }
            Err(e @ (auth::AuthError::Blocked | auth::AuthError::Locked)) => {
                tracing::warn!(target: "audit", user = %name, reason = e.kind(), "zabbix sign-in refused");
                (403, json!({ "ok": false, "kind": e.kind(),
                              "message": format!("{name} is {} in ElasticPro — an ElasticPro administrator can change that on the Accounts page",
                                                 if matches!(e, auth::AuthError::Locked) { "locked" } else { "blocked" }) }))
            }
            Err(e) => (500, json!({ "ok": false, "kind": "io_error", "message": e.to_string() })),
        }
    }

    /// `GET /sso/zabbix/role`: what ElasticPro role a Zabbix user has here, for the clients
    /// module's "who may edit Cluster Management". Read-only: no account is made or
    /// refreshed and no session or code is issued.
    ///
    /// `claim` is the signed JSON `{zabbix_user, zabbix_user_type, ts, nonce}` (exact bytes),
    /// checked like the sign-in: `allowedSources`, a per-source budget, the signature, the
    /// clock and the nonce. The answer names the namespaced account's role, whether an admin
    /// pinned it, and its source; `role: null` when ElasticPro has never seen this person
    /// (the module then uses the Zabbix mapping). A verified question gets a signed answer —
    /// `RoleReply::signature`, over the question's ts and nonce — so the module can refuse an
    /// answer that did not come from here.
    pub fn zabbix_sso_role_from(&self, claim: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> RoleReply {
        let (status, mut out, asked) = self.zabbix_sso_role_answer(claim, signature, source);
        crate::errors::stamp(&mut out);
        let body = serde_json::to_vec(&out).unwrap_or_default();
        let signature = asked.and_then(|(ts, nonce)| self.zbx.sign_reply(ts, &nonce, &body));
        RoleReply { status, body, signature }
    }

    /// `POST /sso/zabbix/cluster-secret`: the Zabbix module hands over an Elasticsearch password an
    /// admin typed in Cluster Management — a cluster's own (`cluster` = the cluster host's
    /// technical name) or the default (`cluster: "*"`). Checked like the role lookup —
    /// `allowedSources`, a per-source budget, the signature, the clock and the nonce — then kept
    /// encrypted (`cluster_secrets`) and answered signed over the request's ts and nonce. The
    /// password is in no log, no answer and no error.
    pub fn zabbix_cluster_secret_from(&self, body: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> RoleReply {
        let (status, mut out, asked) = self.zabbix_cluster_secret_answer(body, signature, source);
        crate::errors::stamp(&mut out);
        let body = serde_json::to_vec(&out).unwrap_or_default();
        let signature = asked.and_then(|(ts, nonce)| self.zbx.sign_reply(ts, &nonce, &body));
        RoleReply { status, body, signature }
    }

    fn zabbix_cluster_secret_answer(&self, body: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> (u16, Value, Option<(u64, String)>) {
        if self.edition != Edition::Hosted {
            return (404, json!({ "ok": false, "message": "not available in this build" }), None);
        }
        if !self.zbx_link.source_ok(source) {
            return (403, json!({ "ok": false, "kind": "forbidden", "message": "this source may not hand over passwords" }), None);
        }
        if !self.zbx_link.trusted_source(source) && !self.zbx_link.rate_ok("sso_secret", source, crate::zbx_link::SSO_PER_MIN) {
            return (429, json!({ "ok": false, "kind": "rate_limited", "message": "too many requests — wait a minute" }), None);
        }
        let q = match self.zbx.verify_secret_push(body, signature, auth::now()) {
            Ok(q) => q,
            Err(e) => {
                let (status, kind) = match &e {
                    zbx_sso::SsoError::NotConfigured => (503, "not_configured"),
                    zbx_sso::SsoError::BadSignature => (401, "bad_signature"),
                    zbx_sso::SsoError::Stale => (401, "stale"),
                    zbx_sso::SsoError::Replayed => (401, "replayed"),
                    zbx_sso::SsoError::BadBody(_) => (400, "bad_request"),
                    zbx_sso::SsoError::NoRole(_) => (403, "no_role"),
                };
                tracing::debug!(reason = %e, "cluster password hand-over refused");
                return (status, json!({ "ok": false, "kind": kind, "message": e.to_string() }), None);
            }
        };
        let now = auth::now();
        if let Err(why) = self.cluster_secrets.set(&q.cluster, &q.user, &q.password, &q.set_by, now) {
            tracing::warn!(target: "audit", cluster = %q.cluster, error = %why, "cluster password not kept");
            return (500, json!({ "ok": false, "kind": "io_error", "message": format!("the password could not be kept: {why}"),
                                 "ts": q.ts, "nonce": q.nonce }), Some((q.ts, q.nonce)));
        }
        tracing::info!(target: "audit", cluster = %q.cluster, by = %q.set_by, "cluster password handed over from Zabbix and kept encrypted");
        (200, json!({ "ok": true, "cluster": q.cluster, "set_at": now, "ts": q.ts, "nonce": q.nonce }), Some((q.ts, q.nonce)))
    }

    /// The credential the core holds for a Zabbix cluster: its own when its password macro is on
    /// the host, else the default (`cluster_secrets::ClusterSecrets::for_cluster`).
    pub(crate) fn held_secret(&self, host: &str, password_on_host: bool) -> Option<crate::cluster_secrets::Held> {
        self.cluster_secrets.for_cluster(host, password_on_host)
    }

    fn zabbix_sso_role_answer(&self, claim: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> (u16, Value, Option<(u64, String)>) {
        if self.edition != Edition::Hosted {
            return (404, json!({ "ok": false, "message": "not available in this build" }), None);
        }
        if !self.zbx_link.source_ok(source) {
            tracing::debug!(source = ?source, "zabbix role lookup refused: source not in allowedSources");
            return (403, json!({ "ok": false, "kind": "forbidden", "message": "this source may not ask about Zabbix users" }), None);
        }
        if !self.zbx_link.trusted_source(source) && !self.zbx_link.rate_ok("sso_role", source, crate::zbx_link::SSO_PER_MIN) {
            tracing::debug!(source = ?source, "zabbix role lookup refused: rate limited");
            return (429, json!({ "ok": false, "kind": "rate_limited", "message": "too many role lookups — wait a minute" }), None);
        }
        let q = match self.zbx.verify_role_query(claim, signature, auth::now()) {
            Ok(q) => q,
            Err(e) => {
                let (status, kind) = match &e {
                    zbx_sso::SsoError::NotConfigured => (503, "not_configured"),
                    zbx_sso::SsoError::BadSignature => (401, "bad_signature"),
                    zbx_sso::SsoError::Stale => (401, "stale"),
                    zbx_sso::SsoError::Replayed => (401, "replayed"),
                    zbx_sso::SsoError::BadBody(_) => (400, "bad_request"),
                    zbx_sso::SsoError::NoRole(_) => (403, "no_role"),
                };
                // Never the signature or the body: the reason is enough to configure by.
                tracing::debug!(reason = %e, "zabbix role lookup refused");
                return (status, json!({ "ok": false, "kind": kind, "message": e.to_string() }), None);
            }
        };
        let name = zbx_sso::account_name(&q.zabbix_user);
        // What a first sign-in would make this person, under the map as it is now.
        let zabbix_role = self.zbx_options_now().role_map.resolve(q.zabbix_role.as_deref(), q.zabbix_user_type).map(|r| r.as_str());
        // Only an account a Zabbix sign-in made counts. A local account that happens to have
        // the namespaced name is somebody else's, exactly as the sign-in refuses to take it over.
        let acct = self.users.list().into_iter()
            .find(|a| a.name.eq_ignore_ascii_case(&name) && a.source.as_deref() == Some(zbx_sso::SOURCE));
        let mut out = match &acct {
            Some(a) => json!({ "ok": true, "account": a.name, "role": a.role.as_str(), "pinned": a.role_pinned,
                               "source": zbx_sso::SOURCE, "disabled": a.disabled, "locked": a.is_locked(auth::now()),
                               "zabbix_role": zabbix_role }),
            None => json!({ "ok": true, "account": name, "role": null, "pinned": false, "source": null,
                            "disabled": false, "locked": false, "zabbix_role": zabbix_role }),
        };
        // Echoed so the module can check the answer is to the question it asked; the
        // signature over them is what makes the echo worth anything.
        out["ts"] = json!(q.ts);
        out["nonce"] = json!(q.nonce);
        tracing::debug!(account = %name, role = ?acct.as_ref().map(|a| a.role.as_str()),
                        pinned = acct.as_ref().is_some_and(|a| a.role_pinned), "zabbix role lookup answered");
        (200, out, Some((q.ts, q.nonce)))
    }

    async fn tunnel_status(&self) -> Vec<Value> {
        let ts = self.tunnels.read().await;
        let mut v: Vec<Value> = ts.values().map(|r| r.tunnel.status_json(Some(r.socks.port))).collect();
        v.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        v
    }

    async fn make_route(self: &Arc<Self>, spec: JumpSpec) -> Result<Route1, String> {
        let tunnel = Tunnel::new(spec, self.pins.clone());
        let socks = socks::start(tunnel.clone()).await.map_err(|e| format!("socks listener: {e}"))?;
        Ok(Route1 { tunnel, socks })
    }

    async fn close_tunnels(self: &Arc<Self>) {
        let mut ts = self.tunnels.write().await;
        for (_, r) in ts.drain() {
            r.tunnel.close().await;
        }
    }

    async fn prime(self: &Arc<Self>, msg: Value) -> Value {
        // New credentials or addresses may follow: nothing read under the old ones is kept.
        self.read_cache.clear();
        let p: PrimeMsg = match serde_json::from_value(msg.clone()) {
            Ok(p) => p,
            Err(e) => return json!({ "ok": false, "message": format!("bad PRIME: {e}") }),
        };
        let mut incoming = p.clusters;
        if self.config_hint.is_some() {
            self.refresh_trust_switch().await;
        } else {
            // Every PRIME states the switch; one that does not mention it means off, so a
            // page that never sends it cannot leave an earlier "on" standing.
            let on = match crate::settings::get().text("UI_TLS") {
                Some(tls) => tls == "insecure",
                None => p.accept_all_certificates == Some(true),
            };
            if self.pins.set_accept_all(on) {
                tracing::warn!(target: "audit", on, "defaults.tls: insecure is {}", if on { "on" } else { "off" });
            }
        }
        let (held, anonymous, effective) = {
            let mut cur = self.primed.write();
            // A cluster that arrives with no credential at all keeps the one the core already
            // holds for it — same id, same URL. The browser that sent this may simply not
            // have it: on the hosted build every page load re-reads a config file that holds
            // no password, and the one an admin typed lives here, not there. Wiping it on
            // every reload was the "asks for the password on every page" bug.
            //
            // A different URL never inherits: that would be sending a credential somewhere
            // nobody gave it to. An explicit empty string is "no credential, on purpose"
            // (continue anonymously, forget the credential) and is kept as sent.
            for c in incoming.iter_mut() {
                if c.auth_header.is_none() {
                    if let Some(old) = cur.clusters.get(&c.id) {
                        if old.url.trim_end_matches('/') == c.url.trim_end_matches('/') {
                            c.auth_header = old.auth_header.clone();
                        }
                    }
                }
            }
            cur.clusters = incoming.drain(..).map(|c| (c.id.clone(), c)).collect();
            // config.txt's UI_READ_ONLY wins over what the page sends, so a managed
            // read-only cannot be lifted by a PRIME from the browser.
            cur.read_only = crate::settings::get().flag("UI_READ_ONLY").unwrap_or(p.read_only != Some(false));
            match p.shared_auth_header.as_deref() {
                None => {}
                Some("") => cur.shared_auth = None,
                Some(h) => cur.shared_auth = Some(h.to_string()),
            }
            let mut held: Vec<String> = cur.clusters.values()
                .filter(|c| c.auth_header.as_deref().is_some_and(|a| !a.is_empty()))
                .map(|c| c.id.clone()).collect();
            held.sort();
            // The explicit empty header is a decision — "this cluster needs no credential" —
            // and it is kept here like any other. The page is told, so a fresh page load
            // (which re-reads a config file that never records that decision) does not ask
            // for a password the cluster was deliberately connected without.
            let mut anonymous: Vec<String> = cur.clusters.values()
                .filter(|c| c.auth_header.as_deref() == Some(""))
                .map(|c| c.id.clone()).collect();
            anonymous.sort();
            let mut effective: Vec<ClusterSpec> = cur.clusters.values().cloned().collect();
            effective.sort_by(|a, b| a.id.cmp(&b.id));
            (held, anonymous, effective)
        };
        // What is kept on disk is what the core now holds, retained credentials included —
        // not the message, which may have carried none. Jump hosts are taken from the
        // message because the specs here can carry a session passphrase, and that is
        // never written anywhere.
        self.persist_prime(
            &json!({ "readOnly": p.read_only, "clusters": effective, "jumpHosts": msg.get("jumpHosts").cloned().unwrap_or(json!([])),
                     "sharedAuthHeader": self.primed.read().shared_auth.clone().unwrap_or_default() }),
            p.persist != Some(false),
        );
        self.forget_connections();

        // Keep tunnels whose spec is unchanged (a live SSH session is worth keeping);
        // replace the rest. Session secrets (passphrase/password) survive a re-prime
        // that does not carry them.
        let mut ts = self.tunnels.write().await;
        let mut keep: HashMap<String, Route1> = HashMap::new();
        for mut spec in p.jump_hosts {
            if let Some(old) = ts.remove(&spec.id) {
                let o = &old.tunnel.spec;
                if spec.passphrase.is_none() {
                    spec.passphrase = o.passphrase.clone();
                }
                if spec.password.is_none() {
                    spec.password = o.password.clone();
                }
                if o.host == spec.host && o.port == spec.port && o.user == spec.user && o.key_file == spec.key_file
                    && o.passphrase == spec.passphrase && o.password == spec.password
                {
                    keep.insert(spec.id.clone(), old);
                    continue;
                }
                old.tunnel.close().await;
            }
            match self.make_route(spec.clone()).await {
                Ok(r) => {
                    keep.insert(spec.id.clone(), r);
                }
                Err(e) => tracing::error!("jump host {}: {e}", spec.id),
            }
        }
        for (_, r) in ts.drain() {
            r.tunnel.close().await;
        }
        *ts = keep;
        let n_t = ts.len();
        drop(ts);
        let p = self.primed.read();
        json!({ "ok": true, "count": p.clusters.len(), "readOnly": p.read_only, "tunnels": n_t, "held": held, "anonymous": anonymous })
    }

    async fn es(self: &Arc<Self>, msg: Value, caller: Option<&Caller>) -> Value {
        let mut req: EsRequest = match serde_json::from_value(msg) {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "kind": "bad_message", "message": format!("bad ES request: {e}") }),
        };
        req.user = caller.map(|c| c.name.clone());
        // A person asked. Decided here, by the way the request came in — never by its origin.
        req.class = Class::Interactive;
        self.es_req(req).await
    }

    /// Whether leaving the page that asked may cancel the request: a page's or the console's,
    /// never the poller's, the delay sink's or another part of the core's.
    fn abortable(origin: &str) -> bool {
        origin.starts_with("page:") || origin == "console"
    }

    fn abort_key(user: Option<&str>, origin: &str) -> String {
        format!("{}\u{1}{}", user.unwrap_or(""), origin)
    }

    /// `ABORT_REQUESTS {origin}`: the caller's own requests from that origin stop waiting —
    /// for a slot or for the cluster — and answer "aborted". Nothing is sent to the cluster;
    /// a search already running there is the ES task reaper's to cancel.
    fn abort_requests(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let origin = msg.get("origin").and_then(Value::as_str).unwrap_or("");
        if !Self::abortable(origin) {
            return json!({ "ok": false, "kind": "bad_request", "message": "only a page's or the console's requests can be aborted" });
        }
        let key = Self::abort_key(caller.map(|c| c.name.as_str()), origin);
        let n = {
            let mut a = self.aborts.lock();
            match a.get_mut(&key) {
                Some(slot) => {
                    slot.gen += 1;
                    slot.notify.notify_waiters();
                    slot.count
                }
                None => 0,
            }
        };
        json!({ "ok": true, "aborted": n })
    }

    /// Counted in under a person's abort key until the guard is dropped, however the
    /// request ends.
    fn abort_reg(self: &Arc<Self>, user: Option<&str>, origin: &str) -> AbortReg {
        let key = Self::abort_key(user, origin);
        let (notify, gen) = {
            let mut a = self.aborts.lock();
            let slot = a.entry(key.clone()).or_insert_with(|| AbortSlot { notify: Arc::new(tokio::sync::Notify::new()), count: 0, gen: 0 });
            slot.count += 1;
            (slot.notify.clone(), slot.gen)
        };
        AbortReg { core: self.clone(), key, notify, gen }
    }

    /// Resolves when this registration is aborted; never, without one.
    async fn until_aborted(&self, reg: Option<&AbortReg>) {
        let Some(reg) = reg else { return std::future::pending().await };
        let notified = reg.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        // An abort that landed between registering and listening is not missed.
        if self.aborts.lock().get(&reg.key).is_none_or(|s| s.gen != reg.gen) {
            return;
        }
        notified.await
    }

    fn begin_record(&self, ctx: &Outgoing, state: &'static str) -> u64 {
        self.requests.lock().begin(NewRecord {
            cluster: &ctx.req.cluster_id, origin: &ctx.origin, method: &ctx.req.method, path: &ctx.req.path,
            via: ctx.via.as_deref(), user: ctx.req.user.as_deref(), class: ctx.req.class, state,
            timeout_ms: ctx.timeout_ms, read: ctx.read,
        })
    }

    /// Every request to a cluster goes through here: a page's (`es`), the poller's, the
    /// delay sink's and the task reaper's. So all of them take the same jump hosts, pinned
    /// certificates, credentials, read-only guard — and the same gate.
    ///
    /// In order: resolve where it goes; for a person's read, answer from the read cache or
    /// join the same request already on its way; else record it (queued), register its
    /// abort, wait at the gate, send. One guard closes the record however that ends.
    pub(crate) async fn es_req(self: &Arc<Self>, mut req: EsRequest) -> Value {
        let (spec, read_only) = (self.spec_for(&req.cluster_id), self.primed.read().read_only);
        // Like the extension: an explicit authHeader in the request wins (diagnostic
        // probes send "" for "no credential"); otherwise the primed one; none = re-prime.
        let (auth, url, via, tls) = match (&req.auth_header, &spec) {
            (Some(a), Some(s)) => (Some(a.clone()), req.url.clone().unwrap_or(s.url.clone()), s.via.clone(), s.tls.clone()),
            (Some(a), None) => (Some(a.clone()), req.url.clone().unwrap_or_default(), None, None),
            (None, Some(s)) => (s.auth_header.clone(), req.url.clone().unwrap_or(s.url.clone()), s.via.clone(), s.tls.clone()),
            (None, None) => return json!({ "ok": false, "kind": "no_creds", "message": "Not primed; re-priming." }),
        };
        if url.is_empty() {
            return json!({ "ok": false, "kind": "bad_message", "message": "no url" });
        }
        let via = via.filter(|v| !v.is_empty());
        // The tunnel is looked up and the lock let go before anything is awaited. Holding
        // it across the request meant a PRIME or a TUNNEL_SECRET — which take it for
        // writing — waited for the slowest request in flight, and every request after
        // them waited too.
        let tunnel: Option<(Arc<Tunnel>, u16)> = match via.as_deref() {
            Some(id) => {
                let ts = self.tunnels.read().await;
                match ts.get(id) {
                    Some(r) => Some((r.tunnel.clone(), r.socks.port)),
                    None => {
                        return json!({ "ok": false, "status": 0, "kind": "tunnel_error", "tunnelKind": "missing",
                                       "message": format!("cluster routes via jump host {id:?}, which is not defined under jump_hosts: in clusters.yaml"),
                                       "url": url })
                    }
                }
            }
            None => None,
        };
        let cfg = self.req_cfg.read().clone();
        // No request is given longer than the gate's ceiling, whatever it asked for: nginx
        // gives up on the core at 120 s, and a reply nobody receives is only load.
        let timeout_ms = req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, cfg.limits.max_timeout_ms);
        req.timeout_ms = Some(timeout_ms);
        let origin = req.origin.clone().unwrap_or_else(|| "core".into());
        let writes = if req.verified_cancel && crate::guard::is_task_cancel(&req.method, &req.path) {
            Writes::VerifiedTaskCancel
        } else {
            Writes::decide(read_only, self.writes_unlocked(), req.allow_writes)
        };
        let read = crate::guard::is_read(&req.method, &req.path);
        let method = req.method.trim().to_ascii_uppercase();
        // Shared and cached only what the core would send the same for anybody: a person's
        // read, to the cluster's own address, with the cluster's own credential.
        let own_address = req.url.as_deref().is_none_or(|u| spec.as_ref().is_some_and(|s| s.url.trim_end_matches('/') == u.trim_end_matches('/')));
        let shareable = req.class == Class::Interactive && read && req.auth_header.is_none() && own_address && !req.allow_writes;
        // Never cached: the console (a person typing wants the cluster's answer), the task
        // list (it is about right now), and `/` — the connection probe, which must notice a
        // cluster that went away or a certificate that changed the moment it happens.
        let bare = req.path.split('?').next().unwrap_or("");
        let cacheable = shareable && cfg.read_cache_secs > 0 && (method == "GET" || method == "HEAD")
            && origin != "console" && !bare.starts_with("/_tasks") && !bare.is_empty() && bare != "/";
        let key = shareable.then(|| crate::inflight::key(&req.cluster_id, &url, &method, &req.path, req.body.as_deref(), auth.as_deref()));
        if let (true, Some(k)) = (cacheable, key.as_ref()) {
            let max_ms = req.max_age_ms.unwrap_or(u64::MAX).min(cfg.read_cache_secs.saturating_mul(1000));
            if max_ms > 0 {
                if let Some((v, age)) = self.read_cache.get(k, Duration::from_millis(max_ms)) {
                    return self.answer_cached(&req, &origin, via.as_deref(), timeout_ms, v, age);
                }
            }
        }
        let ctx = Outgoing {
            req, url, auth, via, tunnel, tls: TlsMode::parse(tls.as_deref()), writes, origin, timeout_ms, read,
            cache_key: key.filter(|_| cacheable),
        };
        match key {
            Some(k) => self.es_shared(k, ctx).await,
            None => self.es_inline(ctx).await,
        }
    }

    /// A read answered from the cache: recorded, counted, and marked as such.
    fn answer_cached(&self, req: &EsRequest, origin: &str, via: Option<&str>, timeout_ms: u64, v: Arc<Value>, age_ms: u64) -> Value {
        let mut out = (*v).clone();
        out["cached"] = json!(true);
        out["ageMs"] = json!(age_ms);
        let bytes = out.get("bytes").and_then(Value::as_u64);
        let (ok, status) = status_of(&out);
        {
            let mut log = self.requests.lock();
            let id = log.begin(NewRecord {
                cluster: &req.cluster_id, origin, method: &req.method, path: &req.path, via, user: req.user.as_deref(),
                class: req.class, state: "done", timeout_ms, read: true,
            });
            log.amend(id, |r| { r.cached = true; r.age_ms = Some(age_ms); });
            log.finish_with(id, 0, ok, status, bytes);
        }
        self.gate.note_cached(bytes.unwrap_or(0));
        out
    }

    /// A request nobody else can share: its own record, its own abort, then the gate.
    async fn es_inline(self: &Arc<Self>, mut ctx: Outgoing) -> Value {
        let rid = self.begin_record(&ctx, "queued");
        ctx.req.opaque_id = Some(opaque_id(&self.instance, &ctx.origin, &ctx.req.cluster_id, rid));
        // A person's request can be let go of when its page is: registered before it waits,
        // so an ABORT_REQUESTS that arrives while it is queued finds it too.
        let reg = (ctx.req.class == Class::Interactive).then(|| self.abort_reg(ctx.req.user.as_deref(), &ctx.origin));
        self.run_upstream(ctx, rid, reg.as_ref()).await
    }

    /// A person's read that others may be asking for at the same moment: join the one on
    /// its way, or start it as a task of its own, and wait for its answer with this caller's
    /// own timeout and abort. Leaving never cancels it for the others; the last one out does.
    async fn es_shared(self: &Arc<Self>, key: crate::inflight::Key, ctx: Outgoing) -> Value {
        let started = Instant::now();
        let reg = self.abort_reg(ctx.req.user.as_deref(), &ctx.origin);
        let me = ctx.clone();
        // Recorded first, as the request that will go if nobody else's is on its way; turned
        // into a "shared" record below if somebody's is. Nothing is locked while the flights
        // are: the two locks are never held together.
        let rid = self.begin_record(&ctx, "queued");
        let core = self.clone();
        let flights = self.flights.clone();
        let joined = self.flights.join_or_start(key, rid, move |tx| {
            let mut ctx = ctx;
            ctx.req.opaque_id = Some(opaque_id(&core.instance, &ctx.origin, &ctx.req.cluster_id, rid));
            let task = tokio::spawn(async move {
                let out = core.run_upstream(ctx, rid, None).await;
                tx.send_replace(Some(Arc::new(out)));
                flights.done(&key, rid);
            });
            task.abort_handle()
        });
        let leader = joined.leader;
        let seat = crate::inflight::Seat::new(self.flights.clone(), key, leader);
        let mut follower = joined.follower.then(|| {
            self.requests.lock().amend(rid, |r| { r.state = "shared"; r.shared = true; r.leader = Some(leader); });
            RecordGuard { core: self.clone(), rid, started, done: false }
        });
        // The one who started it waits for the request itself, which keeps its own time (the
        // queue wait, then the cluster's timeout). One who joined keeps its own clock too: a
        // shorter timeout than the request it joined is still honoured.
        let queue_wait = self.req_cfg.read().limits.queue_wait_ms;
        let deadline = joined.follower.then(|| started + Duration::from_millis(me.timeout_ms + queue_wait.min(me.timeout_ms) + 1_000));
        let mut rx = joined.rx;
        enum Got { Answer(Arc<Value>), Lost, Timeout, Aborted }
        let answer = async { rx.wait_for(|v| v.is_some()).await.map(|v| v.clone()) };
        let bounded = async {
            match deadline {
                Some(d) => tokio::time::timeout_at(d.into(), answer).await.ok(),
                None => Some(answer.await),
            }
        };
        let got = tokio::select! {
            r = bounded => match r {
                Some(Ok(Some(v))) => Got::Answer(v),
                Some(_) => Got::Lost,
                None => Got::Timeout,
            },
            _ = self.until_aborted(Some(&reg)) => Got::Aborted,
        };
        let elapsed = started.elapsed().as_millis() as u64;
        let ended = |out: Value, status: &str, follower: Option<RecordGuard>, seat: crate::inflight::Seat| {
            match follower {
                Some(mut g) => g.finish_ms(&out, elapsed),
                // The one who started it: the request itself goes on for anyone still
                // waiting; if nobody is, it was just cancelled, and says why.
                None => {
                    if seat.leave() {
                        self.requests.lock().finish(leader, elapsed, false, status.to_string());
                    }
                }
            }
            out
        };
        match got {
            Got::Answer(v) => {
                let mut out = (*v).clone();
                if let Some(g) = follower.as_mut() {
                    out["shared"] = json!(true);
                    g.finish_ms(&out, elapsed);
                    self.gate.note_shared();
                }
                drop(seat);
                out
            }
            Got::Aborted => ended(aborted_reply(), "aborted", follower.take(), seat),
            Got::Timeout => ended(json!({ "ok": false, "status": 0, "kind": "timeout", "tookMs": elapsed, "url": me.url,
                                          "message": format!("Request timed out after {:.1} s", elapsed as f64 / 1000.0),
                                          "help": "No answer in time. The cluster may be slow, or a firewall drops packets silently." }),
                                   "timeout", follower.take(), seat),
            Got::Lost => ended(json!({ "ok": false, "status": 0, "kind": "aborted", "tookMs": elapsed,
                                       "message": "cancelled: the request this one was waiting on went away" }),
                               "aborted", follower.take(), seat),
        }
    }

    /// Wait at the gate, send, read, record. The record's guard says `client_gone` if this
    /// future is dropped before it finishes — a client that disconnected, a flight whose
    /// last waiter left.
    async fn run_upstream(self: &Arc<Self>, ctx: Outgoing, rid: u64, abort: Option<&AbortReg>) -> Value {
        let mut rec = RecordGuard { core: self.clone(), rid, started: Instant::now(), done: false };
        let cfg = self.req_cfg.read().clone();
        let cluster = ctx.req.cluster_id.as_str();
        // Refused without a socket — and without taking a slot from anyone.
        if let Some(refused) = crate::http::refuse_early(&ctx.req, &ctx.url, ctx.writes) {
            rec.finish(&refused);
            if refused.get("kind").and_then(Value::as_str) != Some("blocked_readonly") {
                self.record_request(cluster);
            }
            return refused;
        }
        let wait = (ctx.req.class == Class::Interactive).then(|| Duration::from_millis(cfg.limits.queue_wait_ms.min(ctx.timeout_ms)));
        let permit = tokio::select! {
            r = self.gate.admit(ctx.req.class, cluster, ctx.via.as_deref(), ctx.req.user.as_deref(), wait) => match r {
                Ok(p) => p,
                Err(refusal) => {
                    let out = refusal.reply(cluster, &cfg.limits);
                    rec.finish(&out);
                    return out;
                }
            },
            _ = self.until_aborted(abort) => {
                let out = aborted_reply();
                rec.finish(&out);
                return out;
            }
        };
        let queued_ms = permit.queued_ms;
        self.requests.lock().running(rid, queued_ms);
        // Sent from a task of its own that holds the slot until the cluster has answered. A
        // caller that lets go — aborted, or its client gone — gets its answer at once, but
        // the cluster is still working on the request, so its slot stays taken until the
        // answer comes (or the request times out, or the task reaper cancels it there): the
        // gate's numbers are what the clusters actually carry.
        let send = {
            let (core, ctx) = (self.clone(), ctx.clone());
            let (cap_bytes, setting) = if ctx.req.class == Class::Interactive {
                (cfg.max_response_bytes, "ES_MAX_RESPONSE_MB")
            } else {
                (cfg.max_fleet_response_bytes, "ES_MAX_FLEET_RESPONSE_MB")
            };
            tokio::spawn(async move {
                let _slot = permit;
                let route = Route { tunnel: ctx.tunnel.as_ref().map(|(t, p)| (t, *p)), tls: ctx.tls };
                let limit = BodyLimit { cap_bytes, setting, budget: Some(&core.body_budget) };
                core.transport.request(&ctx.req, &ctx.url, ctx.auth.as_deref(), ctx.writes, route, &limit).await
            })
        };
        let mut out = tokio::select! {
            out = send => out.unwrap_or_else(|e| json!({ "ok": false, "status": 0, "kind": "client_error", "tookMs": 0,
                                                          "message": format!("the request failed inside ElasticPro: {e}") })),
            _ = self.until_aborted(abort) => {
                let out = aborted_reply();
                rec.finish_ms(&out, rec.started.elapsed().as_millis() as u64);
                return out;
            }
        };
        if queued_ms > 0 {
            out["queuedMs"] = json!(queued_ms);
        }
        rec.finish(&out);
        self.record_request(cluster);
        if out.get("kind").and_then(Value::as_str) == Some("response_too_large") {
            self.gate.note_too_large();
        }
        let ok = out.get("ok") == Some(&json!(true));
        // A write that went through makes some of the fleet cache, and everything the read
        // cache holds for that cluster, out of date.
        if ok && !ctx.read {
            self.fleet_invalidate(cluster, &ctx.req.method, &ctx.req.path);
            self.read_cache.drop_cluster(cluster);
        }
        if let (true, Some(k)) = (ok, ctx.cache_key) {
            let bytes = out.get("bytes").and_then(Value::as_u64).unwrap_or(u64::MAX);
            if bytes <= crate::gate::READ_CACHE_ENTRY_MAX {
                self.read_cache.put(k, cluster, Arc::new(out.clone()), bytes, cfg.read_cache_bytes);
            }
        }
        out
    }
}

/// A request's timeout when it names none (the transport's own default).
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

fn aborted_reply() -> Value {
    json!({ "ok": false, "status": 0, "kind": "aborted", "message": "cancelled: the page that asked was left", "tookMs": 0 })
}

/// One abort key's registrations: how many requests are under it, and a generation that
/// every `ABORT_REQUESTS` moves on, so a registration made a moment before an abort sees it.
struct AbortSlot {
    notify: Arc<tokio::sync::Notify>,
    count: usize,
    gen: u64,
}

/// A request counted in under its abort key; counted out when dropped.
struct AbortReg {
    core: Arc<Core>,
    key: String,
    notify: Arc<tokio::sync::Notify>,
    gen: u64,
}

impl Drop for AbortReg {
    fn drop(&mut self) {
        let mut a = self.core.aborts.lock();
        if let Some(s) = a.get_mut(&self.key) {
            s.count = s.count.saturating_sub(1);
            if s.count == 0 {
                a.remove(&self.key);
            }
        }
    }
}

/// Closes a request's record. Finished explicitly with the reply; dropped unfinished — the
/// future it lived in was dropped — it records `client_gone`.
struct RecordGuard {
    core: Arc<Core>,
    rid: u64,
    started: Instant,
    done: bool,
}

impl RecordGuard {
    fn finish(&mut self, out: &Value) {
        let ms = out.get("tookMs").and_then(Value::as_u64).unwrap_or_else(|| self.started.elapsed().as_millis() as u64);
        self.finish_ms(out, ms);
    }

    fn finish_ms(&mut self, out: &Value, ms: u64) {
        let (ok, status) = status_of(out);
        self.core.requests.lock().finish_with(self.rid, ms, ok, status, out.get("bytes").and_then(Value::as_u64));
        self.done = true;
    }
}

impl Drop for RecordGuard {
    fn drop(&mut self) {
        if !self.done {
            self.core.requests.lock().finish(self.rid, self.started.elapsed().as_millis() as u64, false, "client_gone".into());
        }
    }
}

/// Everything a request needs once it is resolved, so it can be sent from here or from a
/// task of its own.
#[derive(Clone)]
struct Outgoing {
    req: EsRequest,
    url: String,
    auth: Option<String>,
    via: Option<String>,
    tunnel: Option<(Arc<Tunnel>, u16)>,
    tls: TlsMode,
    writes: Writes,
    origin: String,
    timeout_ms: u64,
    read: bool,
    /// Where to keep the answer in the read cache, if it may be kept.
    cache_key: Option<crate::inflight::Key>,
}

/* ------------------------------------- the reapers ------------------------------------- */

/// How often the request reaper runs; the ES task reaper runs every second time.
pub const REAPER_EVERY: Duration = Duration::from_secs(30);
const TASK_REAPER_EVERY_TICKS: u64 = 2;
/// A record still in flight this long past its own deadline is closed as `reaped`.
const REAP_GRACE_MS: u64 = 5_000;
/// The poller's and the core's requests may wait for a slot without a deadline of their
/// own; one still waiting after this long is closed all the same.
const REAP_QUEUED_BACKGROUND_MS: u64 = 10 * 60_000;
/// How long after a read was let go of the task reaper still looks on that cluster.
const TASK_WINDOW_MS: u64 = 10 * 60_000;
/// The origin the task reaper's own requests carry. Its own timeouts never make a cluster a
/// suspect again, or a cluster that is down would be asked forever.
pub const TASK_REAPER_ORIGIN: &str = "core:task-reaper";

/// Whether an in-flight record has outlived every deadline it could have had.
pub fn overdue(r: &RequestRecord, queue_wait_ms: u64, now: Instant) -> bool {
    let past = |since: Instant, ms: u64| now.saturating_duration_since(since) > Duration::from_millis(ms + REAP_GRACE_MS);
    match r.state {
        "running" => r.running_since.is_some_and(|t| past(t, r.timeout_ms)),
        "shared" => past(r.begun, r.timeout_ms + queue_wait_ms.min(r.timeout_ms) + 1_000),
        "queued" if r.class == Class::Interactive.as_str() => past(r.begun, queue_wait_ms.min(r.timeout_ms)),
        "queued" => past(r.begun, REAP_QUEUED_BACKGROUND_MS),
        _ => false,
    }
}

struct BusyFlag<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for BusyFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Core {
    /// Start the reapers. Called once, inside the runtime, by the bridge binary and the
    /// desktop shell — never by `Core::new`, so the tests run them by hand.
    pub fn start_request_reaper(self: &Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self.reaper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = 0u64;
            loop {
                tokio::time::sleep(REAPER_EVERY).await;
                let Some(core) = weak.upgrade() else { break };
                core.reap_requests();
                tick += 1;
                if tick.is_multiple_of(TASK_REAPER_EVERY_TICKS) && !core.task_reaper_busy.swap(true, Ordering::SeqCst) {
                    let c = core.clone();
                    tokio::spawn(async move {
                        let _busy = BusyFlag(&c.task_reaper_busy);
                        c.reap_es_tasks().await;
                    });
                }
            }
        });
    }

    /// One pass of the request reaper: waiters past their deadline answered, in-flight
    /// records past every deadline closed as `reaped`, empty abort keys dropped, the read
    /// cache aged, and the clusters with reads out written down for the next run.
    #[doc(hidden)]
    pub fn reap_requests(&self) -> usize {
        let expired = self.gate.expire();
        let cfg = self.req_cfg.read().clone();
        let now = Instant::now();
        let reaped: Vec<RequestRecord> = {
            let mut log = self.requests.lock();
            let due: Vec<u64> = log.inflight.values().filter(|r| overdue(r, cfg.limits.queue_wait_ms, now)).map(|r| r.id).collect();
            due.into_iter()
                .filter_map(|id| {
                    let ms = log.inflight.get(&id).map(|r| now.saturating_duration_since(r.begun).as_millis() as u64).unwrap_or(0);
                    log.finish_with(id, ms, false, "reaped".into(), None).cloned()
                })
                .collect()
        };
        for r in &reaped {
            tracing::warn!(cluster = %r.cluster, id = r.id, origin = %r.origin, state = r.state, "request reaped: still in flight past its deadline");
            self.activity.record(crate::activity::ActivityEvent::system(
                "request_reaped", self.edition, Some(&r.cluster), Some(&r.method), Some(&r.path),
                format!("record {} ({}, {}) was still in flight past its deadline and was closed", r.id, r.origin, r.class),
            ));
        }
        self.aborts.lock().retain(|_, s| s.count > 0);
        self.read_cache.prune(Duration::from_secs(cfg.read_cache_secs));
        self.persist_instance_clusters();
        expired + reaped.len()
    }

    /// The clusters this run has reads out on (or let go of lately), in the instance file,
    /// for the next run's task reaper. Written only when the list changes.
    fn persist_instance_clusters(&self) {
        let Some(dir) = &self.data_dir else { return };
        let mut clusters: Vec<String> = {
            let log = self.requests.lock();
            log.inflight.values().filter(|r| r.sent && r.read).map(|r| r.cluster.clone()).chain(log.abandoned.keys().cloned()).collect()
        };
        clusters.sort();
        clusters.dedup();
        let mut written = self.instance_written.lock();
        if *written != clusters {
            write_instance_file(&dir.join(INSTANCE_FILE), &self.instance, &clusters);
            *written = clusters;
        }
    }

    /// One pass of the ES task reaper. Looks only at clusters where a read of ours was let
    /// go of lately (or that the last run had reads out on), and cancels only what
    /// `tasks::choose` allows. Every cancel is recorded in the Request Centre and the
    /// activity log.
    #[doc(hidden)]
    pub async fn reap_es_tasks(self: &Arc<Self>) -> Value {
        let cfg = self.req_cfg.read().clone();
        let now = crate::fleet::now_ms();
        if cfg.task_reaper == crate::gate::ReaperMode::Off {
            let v = json!({ "at": now, "mode": "off", "checked": 0, "cancelled": [] });
            *self.task_reaper_last.lock() = v.clone();
            return v;
        }
        let mut suspects: Vec<String> = {
            let mut log = self.requests.lock();
            log.abandoned.retain(|_, t| now.saturating_sub(*t) < TASK_WINDOW_MS);
            log.abandoned.keys().cloned().collect()
        };
        suspects.extend(std::mem::take(&mut *self.restart_suspects.lock()));
        suspects.sort();
        suspects.dedup();
        suspects.retain(|c| self.spec_for(c).is_some());
        let mut cancelled = Vec::new();
        let mut errors = Vec::new();
        for cluster in &suspects {
            let res = self.es_req(EsRequest {
                cluster_id: cluster.clone(), method: "GET".into(), path: crate::tasks::TASKS_PATH.into(), timeout_ms: Some(15_000),
                origin: Some(TASK_REAPER_ORIGIN.into()), class: Class::Background, ..Default::default()
            }).await;
            if res.get("ok") != Some(&json!(true)) {
                // Looked at again next time, while the window lasts.
                errors.push(json!({ "cluster": cluster, "status": status_of(&res).1 }));
                continue;
            }
            let inflight: std::collections::HashSet<u64> = self.requests.lock().inflight.keys().copied().collect();
            let scope = crate::tasks::Scope {
                cluster, instance: &self.instance, previous: self.previous_instance.as_deref(), inflight: &inflight,
                mode: cfg.task_reaper, max_ms: cfg.task_max_secs * 1000,
            };
            let picks = crate::tasks::choose(res.get("json").unwrap_or(&Value::Null), &scope);
            if picks.is_empty() {
                // Clean: nothing of ours left running there.
                self.requests.lock().abandoned.remove(cluster);
            }
            for p in picks {
                let out = self.es_req(EsRequest {
                    cluster_id: cluster.clone(), method: "POST".into(), path: format!("/_tasks/{}/_cancel", p.task_id), timeout_ms: Some(15_000),
                    origin: Some(TASK_REAPER_ORIGIN.into()), class: Class::Background, verified_cancel: true, ..Default::default()
                }).await;
                let (ok, status) = status_of(&out);
                if ok {
                    if p.current {
                        let mut log = self.requests.lock();
                        if let Some(r) = log.recent.iter_mut().rev().find(|r| r.id == p.n) {
                            r.status = Some("es_task_cancelled".into());
                        }
                    }
                    tracing::info!(target: "audit", cluster = %cluster, task = %p.task_id, opaque_id = %p.opaque, action = %p.action,
                                   "cancelled an orphaned search of ours on the cluster");
                    self.activity.record(crate::activity::ActivityEvent::system(
                        "es_task_cancelled", self.edition, Some(cluster), Some("POST"), Some(&format!("/_tasks/{}/_cancel", p.task_id)),
                        format!("task {} ({}, running {} s), X-Opaque-Id {}", p.task_id, p.action, p.running_ms.unwrap_or(0) / 1000, p.opaque),
                    ));
                }
                cancelled.push(json!({ "cluster": cluster, "task": p.task_id, "opaqueId": p.opaque, "action": p.action,
                                       "runningMs": p.running_ms, "ok": ok, "status": status }));
            }
        }
        let v = json!({ "at": now, "mode": cfg.task_reaper.as_str(), "checked": suspects.len(), "cancelled": cancelled, "errors": errors });
        *self.task_reaper_last.lock() = v.clone();
        v
    }

    /// Replace the request configuration. Tests only: the real one is read from the
    /// environment once, and the environment is one per process.
    #[doc(hidden)]
    pub fn set_request_config_for_tests(&self, cfg: crate::gate::RequestConfig) {
        self.gate.set_limits(cfg.limits.clone());
        *self.req_cfg.write() = cfg;
    }

    /// The configuration in force.
    pub fn request_config(&self) -> crate::gate::RequestConfig {
        self.req_cfg.read().clone()
    }

    /// (running, waiting) at the gate right now.
    #[doc(hidden)]
    pub fn gate_counts(&self) -> (usize, usize) {
        self.gate.counts()
    }

    /// `es_req` with a request built by the caller, class and all. Tests only: in the
    /// product the class is decided by the code path, and no message reaches this.
    #[doc(hidden)]
    pub async fn es_req_as(self: &Arc<Self>, req: EsRequest) -> Value {
        self.es_req(req).await
    }

    /// Drop every cached connection — a trust decision, a tunnel or the cluster list changed —
    /// and every answer read through them: one fetched under the old trust must not be
    /// handed out under the new.
    pub(crate) fn forget_connections(&self) {
        self.transport.forget_clients();
        self.read_cache.clear();
    }

    /// This run's instance id, as it appears in every opaque id.
    pub fn instance_id(&self) -> &str {
        &self.instance
    }
}

/* ---------------------------- the scheduled measurement ---------------------------- */

/// Where the armed setting lives between restarts. Hosted keeps it; the other editions
/// never schedule anything, so they are given the disarmed default and never write a
/// file — a portable copy carried to another machine cannot bring a timer with it.
fn sink_path(data_dir: Option<&std::path::Path>, edition: Edition) -> Option<PathBuf> {
    data_dir.filter(|_| edition.schedules()).map(|d| d.join("delay-sink.json"))
}

fn read_sink_config(data_dir: Option<&std::path::Path>, edition: Edition) -> SinkConfig {
    let Some(path) = sink_path(data_dir, edition) else { return SinkConfig::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<SinkConfig>(&text) {
            Ok(c) => c.normalised(),
            Err(e) => {
                // Disarmed, loudly. A setting we cannot read is not a setting we may
                // guess at, and guessing here would mean writing to a cluster.
                tracing::error!("delay sink: {} is unreadable ({e}); staying disarmed", path.display());
                SinkConfig::default()
            }
        },
        Err(_) => SinkConfig::default(),
    }
}

impl Core {
    /// Start the timer. Called once, from the hosted binary, inside the runtime.
    ///
    /// It ticks every minute and does nothing unless a run is due, so arming, disarming
    /// and re-tuning the interval take effect without restarting anything — there is no
    /// task to cancel and none to leak.
    /// The Zabbix sync, on a timer. Hosted only. It always runs, because the API can be
    /// configured later from Config → Zabbix; while it is not, a tick does nothing. The
    /// interval is read again before every wait, so a new one from the UI applies from the
    /// next tick without a restart.
    pub fn start_zabbix_sync(self: &Arc<Self>) {
        if self.edition != Edition::Hosted {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            loop {
                let every = core.zbx_link.resolved().sync_secs;
                tokio::time::sleep(std::time::Duration::from_secs(every)).await;
                if core.zbx_api().configured() {
                    core.zabbix_sync().await;
                }
            }
        });
        tracing::info!(target: "audit", every_secs = self.zbx_link.resolved().sync_secs,
                       configured = self.zbx_api().configured(), template = self.zbx_api().template(), "zabbix sync: timer started");
    }

    /// Ask Zabbix which hosts are clusters, and Vault for their passwords.
    ///
    /// A cluster whose password cannot be read this time keeps the credential it had, as
    /// long as its address has not changed — Vault being briefly unreachable must not take
    /// every cluster offline. A failed sync keeps the previous list for the same reason,
    /// and says so.
    pub async fn zabbix_sync(self: &Arc<Self>) -> Value {
        self.refresh_trust_switch().await;
        let zapi = self.zbx_api();
        if !zapi.configured() {
            return json!({ "ok": false, "kind": "not_configured",
                           "message": "the Zabbix API is not configured: pair with Zabbix in Config → Zabbix, or set ELASTICPRO_ZABBIX_API_URL and a token on the server" });
        }
        let opts = self.zbx_options().await;
        let fetched = match zapi.clusters().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!(target: "audit", error = %e, "zabbix sync failed; keeping the last list");
                self.zbx_sync.write().error = Some(e.clone());
                return json!({ "ok": false, "kind": "zabbix_error", "message": e });
            }
        };
        // Config clusters Zabbix does not have yet become hosts, when the config says so —
        // and are then read back, so they take over in this same sync.
        let provisioned = if opts.create_hosts { self.provision_hosts(&fetched.0, &opts).await } else { vec![] };
        let (found, skipped, templates) = if provisioned.iter().any(|p| p.starts_with("created")) {
            zapi.clusters().await.unwrap_or(fetched)
        } else {
            fetched
        };
        let templates: Vec<Value> = templates.iter().map(|(n, k)| json!({ "name": n, "hosts": k })).collect();
        let jumps: Vec<(String, String, u16)> = self.tunnels.read().await.iter()
            .map(|(id, r)| (id.clone(), r.tunnel.spec.host.clone(), r.tunnel.spec.port)).collect();
        let jump_ids: std::collections::HashSet<String> = jumps.iter().map(|j| j.0.clone()).collect();
        let previous = self.zbx_sync.read().specs.clone();
        // ElasticPro's own credential for an address: the one held for a config cluster
        // at the same address, else the config's shared one. Both arrived from a browser
        // that built them with authHeaderFor, so nothing here re-derives a header.
        let (held_by_url, shared): (HashMap<String, String>, Option<String>) = {
            let p = self.primed.read();
            (p.clusters.values().filter_map(|s| {
                s.auth_header.as_ref().filter(|a| !a.is_empty()).map(|a| (s.url.trim_end_matches('/').to_ascii_lowercase(), a.clone()))
            }).collect(), p.shared_auth.clone())
        };
        let mut specs = HashMap::new();
        let mut view = Vec::new();
        let mut problems = 0;
        for c in found {
            let id = c.id();
            let mut notes: Vec<String> = vec![];
            let mut user_override: Option<String> = None;
            let own = held_by_url.get(&c.url.trim_end_matches('/').to_ascii_lowercase()).cloned().or_else(|| shared.clone());
            let (credential, secret) = if opts.use_elasticpro_credentials {
                // The config says so: ElasticPro's credential, not Vault's. The header is
                // taken as it is; there is no password to combine with a username.
                match &own {
                    Some(_) => ("elasticpro", None),
                    None => {
                        notes.push("ElasticPro has no credential for this address — add `credentials:` to the config, \
                                    or add it as a cluster and sign in once".into());
                        ("elasticpro", None)
                    }
                }
            } else { match &c.password {
                PasswordRef::Vault(r) => match self.vault.read(r).await {
                    Ok(p) => ("vault", Some(p)),
                    Err(e) => { notes.push(format!("password: {e}")); ("vault", None) }
                },
                PasswordRef::Plain(p) => ("plain-macro", Some(p.clone())),
                PasswordRef::SecretMacro => {
                    // Zabbix never returns a Secret macro; what the module handed over is used instead.
                    let (credential, held, note) = secret_macro_credential(&c, self.held_secret(&c.host, c.password_on_host));
                    if let Some(n) = note { notes.push(n); }
                    match held {
                        Some(h) => {
                            if !h.user.is_empty() { user_override = Some(h.user.clone()); }
                            (credential, Some(h.password))
                        }
                        None => (credential, None),
                    }
                }
                PasswordRef::Missing => ("none", None),
            } };
            let username = user_override.clone().unwrap_or_else(|| c.username.clone());
            let mut auth = if opts.use_elasticpro_credentials { own.clone() } else { secret.as_ref().map(|p| basic(&username, p)) };
            // The last good password carries on only through a Vault outage. ElasticPro's own
            // credential is local and definite: when it is gone, an admin removed it.
            // Never for "password not set": nobody gave the core one, so there is nothing to carry on.
            if auth.is_none() && credential != "none" && credential != "password-not-set" && !opts.use_elasticpro_credentials {
                if let Some(old) = previous.get(&id).filter(|o| o.url == c.url) {
                    auth = old.auth_header.clone();
                    if auth.is_some() {
                        notes.push("using the last password that could be read".into());
                    }
                }
            }
            let via = match c.jump.as_deref() {
                Some(j) if jump_ids.contains(j) => Some(j.to_string()),
                Some(j) => { notes.push(format!("jump host {j:?} is not in ElasticPro's jump_hosts")); None }
                // Behind the Windows jump host Zabbix uses: the same host here, when there is one.
                None => match &c.jump_addr {
                    Some(a) => {
                        let found = crate::zabbix_api::match_jump(a, jumps.iter().map(|(i, h, p)| (i.as_str(), h.as_str(), *p)));
                        if found.is_none() {
                            notes.push(format!("behind jump host {}:{} (Zabbix goes through it over SSH); add it under jump_hosts to reach it from here", a.0, a.1));
                        }
                        found
                    }
                    None => None,
                },
            };
            let usable = auth.is_some() || credential == "none";
            if !usable || !notes.is_empty() {
                problems += 1;
            }
            // Only a cluster the core can sign in to is polled and reachable. One whose
            // credential cannot be read stays in the listing below, with why — polling it
            // meant a 401 on every interval (69 an hour on one cluster), each one a failed
            // sign-in against the cluster's own account.
            if usable {
                specs.insert(id.clone(), ClusterSpec {
                    id: id.clone(), name: Some(c.name.clone()), url: c.url.clone(), auth_header: auth, via: via.clone(), tls: None,
                    zabbix_groups: c.readers.clone(), log_index_pattern: None,
                });
            }
            view.push(json!({
                "_id": id, "name": c.name, "url": c.url, "via": via, "source": "zabbix",
                "zabbixHost": c.host, "zabbixHostId": c.hostid, "client": c.client,
                "zabbixGroups": c.readers, "username": c.username,
                "credential": credential, "credentialOk": usable, "notes": notes,
            }));
        }
        view.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let n = view.len();
        let in_use = specs.len();
        {
            let mut z = self.zbx_sync.write();
            z.specs = specs;
            z.view = view;
            z.last_ok = Some(auth::now());
            z.error = None;
            z.skipped = skipped.clone();
            z.options = opts.clone();
            z.provisioned = provisioned.clone();
            z.templates = templates.clone();
        }
        self.forget_connections();
        tracing::info!(target: "audit", clusters = n, skipped = skipped.len(), problems,
                       credentials = if opts.use_elasticpro_credentials { "elasticpro" } else { "zabbix" }, "zabbix sync");
        json!({ "ok": true, "clusters": n, "inUse": in_use, "skipped": skipped, "problems": problems, "provisioned": provisioned, "templates": templates,
                "credentials": if opts.use_elasticpro_credentials { "elasticpro" } else { "zabbix" } })
    }

    /// `zabbix.createHosts`: one Zabbix host per config cluster that Zabbix does not have.
    ///
    /// The password goes to Vault and the host only ever carries a reference to it. The
    /// cluster's `zabbixGroups` are granted read on its client group, so the people who
    /// could see it before it moved to Zabbix still can — Zabbix wins from the next sync,
    /// and it decides by those permissions.
    ///
    /// Returns one line per cluster considered: "created …", or why not.
    async fn provision_hosts(&self, in_zabbix: &[crate::zabbix_api::ZbxCluster], opts: &ZbxOptions) -> Vec<String> {
        use crate::zabbix_api::{slug, split_url, technical_name, NewHost};
        let key = |u: &str| u.trim_end_matches('/').to_ascii_lowercase();
        let have: std::collections::HashSet<String> = in_zabbix.iter().map(|c| key(&c.url)).collect();
        let candidates: Vec<ClusterSpec> = self.primed.read().clusters.values()
            .filter(|s| !s.id.starts_with("zbx-") && !have.contains(&key(&s.url))).cloned().collect();
        if candidates.is_empty() {
            return vec![];
        }
        if !self.zbx_writer.configured() {
            return vec!["createHosts is on, but no Zabbix write token is configured (ELASTICPRO_ZABBIX_API_WRITE_TOKEN_FILE)".into()];
        }
        let mut out = vec![];
        let cluster_tpl = match self.zbx_writer.template_id(self.zbx_api().template()).await {
            Ok(Some(t)) => t,
            Ok(None) => return vec![format!("createHosts: no template named {:?} in Zabbix", self.zbx_api().template())],
            Err(e) => return vec![format!("createHosts: {e}")],
        };
        // ElasticPro's own two templates, when Zabbix has them: the client plan, and the
        // alert rules Zabbix raises as problems — so a created host alarms like any other.
        let mut own_tpls = vec![];
        for (var, default) in [("ELASTICPRO_ZABBIX_PLAN_TEMPLATE", "ElasticPro client plan"),
                               ("ELASTICPRO_ZABBIX_ALERT_TEMPLATE", "ElasticPro alerts")] {
            if let Ok(Some(t)) = self.zbx_writer.template_id(&std::env::var(var).unwrap_or_else(|_| default.into())).await {
                own_tpls.push(t);
            }
        }
        let cluster_group = match self.zbx_writer.ensure_group(&opts.host_group).await {
            Ok(g) => g,
            Err(e) => return vec![format!("createHosts: {e}")],
        };
        for s in candidates {
            let name = s.name.clone().unwrap_or_else(|| s.id.clone());
            let host = technical_name(&name);
            let Some((scheme, es_host, port)) = split_url(&s.url) else {
                out.push(format!("{name}: {} is not an http(s) address", s.url));
                continue;
            };
            match self.zbx_writer.host_exists(&host).await {
                Ok(true) => {
                    out.push(format!("{name}: a Zabbix host named {host:?} exists but does not carry the cluster template — link it there"));
                    continue;
                }
                Err(e) => { out.push(format!("{name}: {e}")); continue; }
                Ok(false) => {}
            }
            // Only a username and password can become Zabbix macros; an API key or a bearer
            // token has no place in the template, so the host is created without one.
            let basic = s.auth_header.as_deref().and_then(|h| h.strip_prefix("Basic ")).and_then(|b| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.decode(b).ok()
            }).and_then(|b| String::from_utf8(b).ok()).and_then(|up| up.split_once(':').map(|(u, p)| (u.to_string(), p.to_string())));
            let mut note = String::new();
            let password_ref = match (&basic, self.vault_writer.configured()) {
                (Some((u, p)), true) => {
                    let path = format!("secret/elasticpro/{}", slug(&name));
                    match self.vault_writer.write(&path, json!({ "username": u, "password": p })).await {
                        Ok(()) => Some(format!("{path}:password")),
                        Err(e) => { note = format!(" (password not stored: {e})"); None }
                    }
                }
                (Some(_), false) => { note = " (no Vault writer configured, so no password macro)".into(); None }
                (None, _) => { note = " (its credential is not a username and password, so no password macro)".into(); None }
            };
            let client_group = match self.zbx_writer.ensure_group(&name).await {
                Ok(g) => g,
                Err(e) => { out.push(format!("{name}: {e}")); continue; }
            };
            let new = NewHost {
                host: host.clone(), name: name.clone(), scheme, es_host, port,
                username: basic.as_ref().map(|(u, _)| u.clone()), password_ref, client: name.clone(),
                group_ids: vec![cluster_group.clone(), client_group.clone()],
                template_ids: std::iter::once(cluster_tpl.clone()).chain(own_tpls.iter().cloned()).collect(),
            };
            match self.zbx_writer.create_host(&new).await {
                Ok(id) => {
                    for g in &s.zabbix_groups {
                        let _ = self.zbx_writer.grant_read(g, &client_group).await;
                    }
                    tracing::info!(target: "audit", cluster = %name, hostid = %id, "zabbix host created from the config");
                    out.push(format!("created {host:?} for {name}{note}"));
                }
                Err(e) => out.push(format!("{name}: {e}")),
            }
        }
        out
    }

    /// What Zabbix last measured for one Zabbix cluster: `{key: {value, clock}}`, cached for
    /// thirty seconds per host so a page refresh in every open tab is one Zabbix call.
    /// The gate has already checked the caller may see this cluster.
    async fn zabbix_metrics(self: &Arc<Self>, msg: &Value) -> Value {
        let id = msg.get("clusterId").and_then(|v| v.as_str()).unwrap_or("");
        let keys: Vec<String> = msg.get("keys").and_then(|v| v.as_array()).into_iter().flatten()
            .filter_map(|k| k.as_str().map(String::from)).collect();
        let hostid = self.zbx_sync.read().view.iter()
            .find(|v| v["_id"].as_str() == Some(id)).and_then(|v| v["zabbixHostId"].as_str().map(String::from));
        let Some(hostid) = hostid else {
            return json!({ "ok": false, "kind": "not_zabbix", "message": format!("{id:?} is not a Zabbix cluster") });
        };
        let cache_key = format!("{hostid}|{}", keys.join(","));
        if let Some((at, v)) = self.zbx_metrics_cache.lock().get(&cache_key) {
            if at.elapsed() < std::time::Duration::from_secs(30) {
                return json!({ "ok": true, "items": v, "now": auth::now(), "cached": true });
            }
        }
        // One Zabbix call per host and key set at a time: every tab that asks while it is on
        // its way waits for the same answer (and the call itself waits for one of
        // ZABBIX_CONCURRENCY slots).
        let mut rx = {
            let mut f = self.zbx_metrics_flights.lock();
            match f.get(&cache_key) {
                Some(rx) => rx.clone(),
                None => {
                    let (tx, rx) = tokio::sync::watch::channel(None);
                    f.insert(cache_key.clone(), rx.clone());
                    let (core, api, k) = (self.clone(), self.zbx_api(), cache_key.clone());
                    tokio::spawn(async move {
                        let v = match api.latest(&hostid, &keys).await {
                            Ok(v) => {
                                let mut c = core.zbx_metrics_cache.lock();
                                c.retain(|_, (at, _)| at.elapsed() < std::time::Duration::from_secs(120));
                                c.insert(k.clone(), (std::time::Instant::now(), v.clone()));
                                json!({ "ok": true, "items": v })
                            }
                            Err(e) => json!({ "ok": false, "kind": "zabbix_error", "message": e }),
                        };
                        tx.send_replace(Some(v));
                        core.zbx_metrics_flights.lock().remove(&k);
                    });
                    rx
                }
            }
        };
        let got = rx.wait_for(|v| v.is_some()).await.ok().and_then(|v| v.clone());
        match got {
            Some(mut v) => {
                if v["ok"] == json!(true) {
                    v["now"] = json!(auth::now());
                }
                v
            }
            None => json!({ "ok": false, "kind": "zabbix_error", "message": "the Zabbix call this was waiting on went away" }),
        }
    }

    /// The Zabbix clusters this caller may see, with nothing secret in them.
    fn zabbix_clusters(&self, caller: Option<&Caller>) -> Value {
        let z = self.zbx_sync.read();
        let admin = caller.is_none_or(|c| c.role >= Role::Admin);
        let clusters: Vec<Value> = z.view.iter().filter(|v| {
            let groups: Vec<String> = v["zabbixGroups"].as_array().into_iter().flatten()
                .filter_map(|g| g.as_str().map(String::from)).collect();
            caller.is_none_or(|c| c.sees(&groups))
        }).map(|v| {
            let mut v = v.clone();
            // Which Zabbix groups can see a cluster, and why its credential failed, are an
            // administrator's business.
            if !admin {
                if let Some(m) = v.as_object_mut() {
                    m.remove("zabbixGroups");
                    m.remove("notes");
                    m.remove("username");
                }
            }
            v
        }).collect();
        json!({
            "ok": true, "configured": self.zbx_api().configured(), "vault": self.vault.configured(),
            "useElasticProCredentials": z.options.use_elasticpro_credentials,
            "createHosts": z.options.create_hosts,
            "canCreateHosts": self.zbx_writer.configured(),
            "provisioned": if admin { json!(z.provisioned) } else { json!([]) },
            "clusters": clusters, "lastSync": z.last_ok,
            "error": if admin { json!(z.error) } else { Value::Null },
            "skipped": if admin { json!(z.skipped) } else { json!([]) },
            "templates": if admin { json!(z.templates) } else { json!([]) },
        })
    }

    pub fn start_delay_sink(self: &Arc<Self>) {
        if !self.edition.schedules() {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                core.delay_sink_tick().await;
            }
        });
        tracing::info!(target: "audit", "delay sink: timer started");
    }

    /// One minute's worth of deciding whether to run.
    async fn delay_sink_tick(self: &Arc<Self>) {
        let now = delay_sink::now_ms();
        let due = {
            let s = self.delay_sink.read();
            if !s.config.enabled {
                return;
            }
            s.state.next_due_at.unwrap_or(now)
        };
        if now < due {
            return;
        }
        self.run_delay_sink().await;
    }

    /// What to show an admin as standing in the way, if anything.
    ///
    /// Only meaningful for a schedule that is armed. A disarmed job is not blocked from
    /// running — nobody asked it to — and saying "cannot run right now" about something
    /// switched off puts a warning on a fresh install before anyone has touched it.
    fn delay_sink_blocker(&self, cfg: &SinkConfig) -> Option<String> {
        if !cfg.enabled {
            return None;
        }
        self.delay_sink_refusal(cfg)
    }

    /// Why a run cannot happen now, if it cannot. Each answer names the thing a person
    /// would have to change, because these are read off a settings page.
    ///
    /// Unlike `delay_sink_blocker` this applies to a disarmed config too: pressing "Run
    /// now" is asking for a run, and a run with no destination still has nowhere to go.
    fn delay_sink_refusal(&self, cfg: &SinkConfig) -> Option<String> {
        if let Some(r) = cfg.refusal() {
            return Some(r);
        }
        let p = self.primed.read();
        if p.clusters.is_empty() {
            return Some(
                "nothing is primed: the core has no cluster credentials until somebody opens the app"
                    .into(),
            );
        }
        if !p.clusters.contains_key(&cfg.sink_cluster_id) {
            return Some(format!("the sink cluster {:?} is not one of the primed clusters", cfg.sink_cluster_id));
        }
        // The session unlock is never persisted and no background task may hold it, so
        // the only gate left is the config's own. See guard.rs.
        if crate::guard::Writes::decide(p.read_only, false, true) == crate::guard::Writes::Blocked {
            return Some(
                "the config is read-only: set readOnly to false to let measurements be written".into(),
            );
        }
        None
    }

    /// Which primed clusters this run measures.
    fn delay_sink_targets(&self, cfg: &SinkConfig) -> Vec<String> {
        let p = self.primed.read();
        if cfg.clusters.is_empty() {
            let mut ids: Vec<String> =
                p.clusters.keys().filter(|id| **id != cfg.sink_cluster_id).cloned().collect();
            ids.sort();
            return ids;
        }
        cfg.clusters.iter().filter(|id| p.clusters.contains_key(*id)).cloned().collect()
    }

    /// Measure every target once and ship the result. Also the body of the admin's
    /// "run it now" button, which is why it does not look at the schedule itself.
    async fn run_delay_sink(self: &Arc<Self>) -> Value {
        let cfg = self.delay_sink.read().config.clone();
        let now = delay_sink::now_ms();

        if let Some(why) = self.delay_sink_refusal(&cfg) {
            let mut s = self.delay_sink.write();
            s.state.last_skipped = Some(why.clone());
            s.state.last_run_at = Some(now);
            // A refusal is not a failure: nothing was attempted, so nothing backs off.
            // It is retried at the normal interval, by which time somebody may have
            // primed the app or turned off read-only.
            s.state.next_due_at = Some(delay_sink::next_due(now, cfg.every_hours, 0));
            tracing::info!(target: "audit", message = "delay sink skipped", reason = %why);
            return json!({ "ok": false, "skipped": why });
        }

        let (year, month, bucket) = delay_sink::month_and_hour_bucket(now);
        let index = delay_sink::index_name(&cfg.index_prefix, year, month);
        let targets = self.delay_sink_targets(&cfg);
        let mut measured = 0usize;
        let mut failed = 0usize;
        let mut first_error: Option<String> = None;

        for id in &targets {
            let res = self.es_req(delay_sink::search_request(id, &cfg)).await;
            if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                failed += 1;
                first_error.get_or_insert_with(|| {
                    format!(
                        "{id}: {}",
                        res.get("message").and_then(|v| v.as_str()).unwrap_or("search failed")
                    )
                });
                continue;
            }
            let payload = res.get("json").cloned().unwrap_or(Value::Null);
            let ms = delay_sink::measurements(&payload, &cfg);
            if ms.is_empty() {
                // No device could be measured. That is a fact about the cluster, not a
                // failure of the job, and it is not written as a row of zeroes.
                continue;
            }
            let body = delay_sink::bulk_body(id, &ms, &index, &bucket);
            let wrote = self.es_req(delay_sink::bulk_request(&cfg, body)).await;
            match delay_sink::bulk_failure(&wrote) {
                None => measured += ms.len(),
                Some(e) => {
                    failed += 1;
                    first_error.get_or_insert(format!("{id}: {e}"));
                }
            }
        }

        let ok = failed == 0;
        {
            let mut s = self.delay_sink.write();
            s.state.runs += 1;
            s.state.last_run_at = Some(now);
            s.state.last_ok = ok;
            s.state.last_skipped = None;
            s.state.last_error = first_error.clone();
            s.state.last_measured = measured;
            s.state.last_failed = failed;
            s.state.consecutive_failures = if ok { 0 } else { s.state.consecutive_failures + 1 };
            s.state.next_due_at =
                Some(delay_sink::next_due(now, cfg.every_hours, s.state.consecutive_failures));
        }
        tracing::info!(
            target: "audit",
            message = "delay sink run",
            clusters = targets.len(), measured, failed, index = %index,
            error = first_error.as_deref().unwrap_or(""),
        );
        json!({ "ok": ok, "measured": measured, "failed": failed, "clusters": targets.len(),
                "index": index, "error": first_error })
    }

    /// `DELAY_SINK_GET` / `DELAY_SINK_SET` / `DELAY_SINK_RUN`. Admin only; see
    /// `auth::required_role`.
    async fn delay_sink_msg(self: &Arc<Self>, t: &str, msg: &Value) -> Value {
        if !self.edition.schedules() {
            return json!({ "ok": false, "supported": false,
                           "message": "scheduled measurement runs only in the hosted edition, \
                                       which is the only one still running when nobody is looking" });
        }
        match t {
            "DELAY_SINK_GET" => {
                let s = self.delay_sink.read();
                json!({ "ok": true, "supported": true, "config": s.config, "state": s.state,
                        "blocked": self.delay_sink_blocker(&s.config) })
            }
            "DELAY_SINK_SET" => {
                let incoming = msg.get("config").cloned().unwrap_or(Value::Null);
                let cfg: SinkConfig = match serde_json::from_value(incoming) {
                    Ok(c) => SinkConfig::normalised(c),
                    Err(e) => return json!({ "ok": false, "message": format!("bad delay sink config: {e}") }),
                };
                if let Some(why) = cfg.refusal() {
                    return json!({ "ok": false, "message": why });
                }
                if let Some(path) = sink_path(self.data_dir.as_deref(), self.edition) {
                    if let Err(e) = std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap_or_default()) {
                        return json!({ "ok": false, "message": format!("could not save: {e}") });
                    }
                }
                let now = delay_sink::now_ms();
                {
                    let mut s = self.delay_sink.write();
                    let every = cfg.every_hours;
                    let armed = cfg.enabled;
                    s.config = cfg;
                    // Arming schedules the first run one interval out, never immediately:
                    // a person setting this up should not have a write leave the process
                    // while they are still typing. "Run now" is a separate button.
                    s.state.next_due_at = armed.then(|| delay_sink::next_due(now, every, 0));
                    s.state.consecutive_failures = 0;
                }
                let s = self.delay_sink.read();
                tracing::info!(target: "audit", message = "delay sink configured", enabled = s.config.enabled);
                json!({ "ok": true, "config": s.config, "state": s.state,
                        "blocked": self.delay_sink_blocker(&s.config) })
            }
            _ => {
                // DELAY_SINK_RUN: the operator pressing it is what makes this one legible
                // — it is the same work the timer does, at a moment somebody chose.
                let out = self.run_delay_sink().await;
                let s = self.delay_sink.read();
                let mut out = out;
                out["state"] = serde_json::to_value(&s.state).unwrap_or(Value::Null);
                out
            }
        }
    }
}

/* --------------------------- the Zabbix link (Config → Zabbix) --------------------------- */

impl Core {
    /// The Zabbix API client as the link says it is now.
    pub(crate) fn zbx_api(&self) -> Arc<Zabbix> {
        self.zbx_api.read().clone()
    }

    /// The Zabbix API at the link's address, with its TLS trust, signed in with another
    /// token: the Zabbix push's own (`ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE`), when it has one.
    pub(crate) fn zbx_api_with_token(&self, token: String) -> Zabbix {
        let r = self.zbx_link.resolved();
        Zabbix::build(r.api_url.clone(), token, String::new(), r.verify_tls, Some(self.pins.clone()))
    }

    /// The link holds the address and the credentials; the cluster template's name comes
    /// from `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE`, which is how a site whose template is not
    /// called `Elasticsearch Cluster by HTTP EP` says so without a rebuild.
    fn zabbix_from(r: &crate::zbx_link::Resolved, pins: Option<Arc<PinStore>>) -> Zabbix {
        let template = std::env::var("ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE").ok().filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| crate::zabbix_api::DEFAULT_TEMPLATE.to_string());
        Zabbix::build(r.api_url.clone(), r.api_token.clone().unwrap_or_default(), template, r.verify_tls, pins)
    }

    /// After any change to the link: a new API client, and the sign-in secret the
    /// resolution now names — or none.
    fn apply_link(&self) {
        let r = self.zbx_link.resolved();
        *self.zbx_api.write() = Arc::new(Core::zabbix_from(&r, Some(self.pins.clone())));
        self.zbx_metrics_cache.lock().clear();
        match &r.sso_secret {
            Some(s) => {
                if let Err(why) = self.zbx.set_secret(s) {
                    tracing::warn!("Zabbix sign-in left off: {why}");
                    self.zbx.clear_secret();
                }
            }
            None => self.zbx.clear_secret(),
        }
    }

    /// Sync in the background, so the message that caused it answers at once.
    fn sync_soon(self: &Arc<Self>) {
        if !self.zbx_api().configured() {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            let out = core.zabbix_sync().await;
            tracing::info!(result = %out, "zabbix sync after a link change");
        });
    }

    /// The link, for tests and for the bridge binary's routes.
    pub fn zabbix_link(&self) -> &crate::zbx_link::ZbxLink {
        &self.zbx_link
    }

    /// `frame-ancestors` for every response the core serves: the paired Zabbix frontend's
    /// origin, `'none'` when there is none, or the server's own value when it sets one.
    pub fn frame_ancestors(&self) -> String {
        if self.edition != Edition::Hosted {
            return "'none'".into();
        }
        self.zbx_link.resolved().frame_ancestors
    }

    /// `ZABBIX_LINK_*` and `ZABBIX_PAIR_BEGIN` / `ZABBIX_UNPAIR`. Admin only (auth.rs).
    async fn zabbix_link_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.edition != Edition::Hosted {
            return json!({ "ok": false, "kind": "not_supported", "supported": false,
                           "message": "the Zabbix connection is configured on the hosted edition only" });
        }
        let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "-".into());
        let now = auth::now();
        match t {
            "ZABBIX_LINK_GET" => self.zabbix_link_status(),
            "ZABBIX_LINK_SET" => match self.zbx_link.set(msg, &by, now) {
                Ok((changed, api)) => {
                    if api {
                        self.apply_link();
                        self.sync_soon();
                    }
                    let mut out = self.zabbix_link_status();
                    out["changed"] = json!(changed);
                    out
                }
                Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e }),
            },
            "ZABBIX_LINK_TEST" => {
                let mut out = self.zbx_api().probe().await;
                out["apiUrl"] = json!(self.zbx_link.resolved().api_url);
                out
            }
            "ZABBIX_PAIR_BEGIN" => {
                let z = msg.get("zabbixUrl").and_then(|v| v.as_str());
                let e = msg.get("epUrl").and_then(|v| v.as_str());
                match self.zbx_link.begin_pair(z, e, &by, now) {
                    // The one answer that carries a secret: the pairing code, to the admin who
                    // asked for it, once. It is never logged — the audit line records only
                    // that a pairing began, for which Zabbix, until when.
                    Ok((code, exp, zabbix_url, ep_url)) => json!({
                        "ok": true, "code": code, "exp": exp, "ttlSecs": crate::zbx_link::PAIR_TTL_SECS,
                        "zabbixUrl": zabbix_url, "epUrl": ep_url,
                        "pasteAt": "Zabbix → Administration → ElasticPro → Pairing code",
                    }),
                    Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e }),
                }
            }
            "ZABBIX_UNPAIR" => match self.zbx_link.unpair(&by, now) {
                Ok(()) => {
                    self.apply_link();
                    if !self.zbx_api().configured() {
                        // The clusters came from a Zabbix this server no longer talks to.
                        *self.zbx_sync.write() = ZbxSync::default();
                        self.forget_connections();
                    }
                    self.zabbix_link_status()
                }
                Err(e) => json!({ "ok": false, "kind": "io_error", "message": e }),
            },
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("unknown message {t}") }),
        }
    }

    fn zabbix_link_status(&self) -> Value {
        let mut out = self.zbx_link.status(auth::now());
        let z = self.zbx_sync.read();
        out["ok"] = json!(true);
        out["supported"] = json!(true);
        out["signIn"] = json!(self.zbx.configured());
        out["sync"] = json!({
            "configured": self.zbx_api().configured(),
            "lastOk": z.last_ok, "error": z.error, "clusters": z.specs.len(), "skipped": z.skipped.len(),
        });
        out
    }

    /// `POST /zabbix/pair`: the Zabbix module finishing a pairing an admin began here.
    /// `source` is the caller's address as the bridge binary worked it out.
    pub fn zabbix_pair(self: &Arc<Self>, body: &[u8], signature: &str, source: Option<std::net::IpAddr>) -> (u16, Value) {
        if self.edition != Edition::Hosted {
            return (404, json!({ "ok": false, "message": "not available in this build" }));
        }
        match self.zbx_link.complete_pair(body, signature, source, auth::now()) {
            Ok(p) => {
                self.apply_link();
                self.sync_soon();
                tracing::info!(target: "audit", user = %p.by, zabbix = %p.zabbix_url, api = %p.api_url,
                               version = %p.zabbix_version, "paired with zabbix");
                (200, json!({ "ok": true, "epVersion": crate::VERSION }))
            }
            Err(e) => (e.status(), json!({ "ok": false, "kind": e.kind(), "message": e.public_message() })),
        }
    }
}

/// `Basic <base64 user:password>`.
fn basic(user: &str, password: &str) -> String {
    use base64::Engine as _;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")))
}

/// A cluster whose password Zabbix keeps as a Secret macro: the credential the core was handed
/// for it — its own when the macro is on the host, else the default — or, with none, "password
/// not set" and nothing to sign in with, so it is listed and NOT polled (polling it meant a 401 on
/// every interval). The label, the credential, and the note to show.
pub(crate) fn secret_macro_credential(c: &crate::zabbix_api::ZbxCluster, held: Option<crate::cluster_secrets::Held>)
    -> (&'static str, Option<crate::cluster_secrets::Held>, Option<String>) {
    match held {
        Some(h) => (if c.password_on_host { "core-secret" } else { "core-default" }, Some(h), None),
        None => ("password-not-set", None, Some(if c.password_on_host {
            "password not set: Zabbix keeps this cluster's own password as a Secret macro, which it never returns, and \
             ElasticPro has not been given it — press \"Change password\" on the client's page in Cluster Management".to_string()
        } else {
            "password not set: the default Elasticsearch credential is a Secret macro, which Zabbix never returns, and \
             ElasticPro has not been given it — set it on Cluster Management → Settings → Default Elasticsearch credential".to_string()
        })),
    }
}
