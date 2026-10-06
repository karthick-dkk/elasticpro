//! The one message API the UI uses. Same message types as the extension's service
//! worker (PING / PRIME / FORGET / ES …) plus the desktop-only ones (tunnels, trust
//! decisions, config file, vault).

use crate::auth::{self, Caller, Edition, Role, Sessions, TokenStore, UserStore};
use crate::delay_sink::{self, SinkConfig, SinkState};
use crate::fleet::events::Reauth;
use crate::guard::Writes;
use crate::http::{ClusterSpec, EsRequest, Route, Transport};
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
}

impl ZbxOptions {
    pub fn from_config(raw: &Value) -> ZbxOptions {
        let z = raw.get("zabbix").cloned().unwrap_or(Value::Null);
        let flag = |a: &str, b: &str| z.get(a).or_else(|| z.get(b)).and_then(|v| v.as_bool()).unwrap_or(false);
        ZbxOptions {
            use_elasticpro_credentials: flag("useElasticProCredentials", "use_elasticpro_credentials"),
            create_hosts: flag("createHosts", "create_hosts"),
            host_group: z.get("hostGroup").or_else(|| z.get("host_group")).and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty()).unwrap_or("Elasticsearch clusters").to_string(),
        }
    }
}

pub(crate) struct Route1 {
    pub(crate) tunnel: Arc<Tunnel>,
    socks: SocksServer,
}

pub struct Core {
    pins: Arc<PinStore>,
    transport: Transport,
    primed: RwLock<Primed>,
    pub(crate) tunnels: tokio::sync::RwLock<HashMap<String, Route1>>,
    data_dir: Option<PathBuf>,
    /// `--config <path>` or ELASTICPRO_CONFIG: a config file to offer when none is remembered.
    config_hint: Option<String>,
    /// The operator's write unlock. Session-only on purpose: never written to disk and
    /// never surviving a restart, so the app always starts read-only.
    writes_unlocked: std::sync::atomic::AtomicBool,
    /// When each request left for each cluster, so "how hard are we hitting it" is a
    /// number rather than a guess. Trimmed to the reporting window on every read.
    request_log: parking_lot::Mutex<HashMap<String, std::collections::VecDeque<std::time::Instant>>>,
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
    /// The fleet cache and its poller. See `fleet`.
    pub(crate) fleet: crate::fleet::Fleet,
    /// How many ES requests may be open at once. See `EsLimits`.
    es_limits: EsLimits,
    /// Each person's notification history. See `notify`.
    notify: crate::notify::NotifyStore,
}

/// Concurrency limits on requests to Elasticsearch, whoever sends them.
///
/// A browser that opens a page for a hundred clusters at once asks for a thousand
/// requests in the same instant, and without a limit each became a socket — through one
/// jump host, to clusters that were already slow. Queued here, most specific first, so a
/// busy cluster waits on its own limit without holding a slot another cluster could use.
struct EsLimits {
    global: Arc<tokio::sync::Semaphore>,
    per_cluster: SemMap,
    per_jump: SemMap,
}

type SemMap = parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>;

/// Requests open at once to one cluster, and through one jump host.
const ES_PER_CLUSTER: usize = 8;
const ES_PER_JUMP: usize = 16;

impl EsLimits {
    fn from_env() -> EsLimits {
        let global = std::env::var("ELASTICPRO_ES_CONCURRENCY").ok().and_then(|v| v.trim().parse().ok())
            .unwrap_or(32usize).clamp(1, 1024);
        EsLimits {
            global: Arc::new(tokio::sync::Semaphore::new(global)),
            per_cluster: parking_lot::Mutex::new(HashMap::new()),
            per_jump: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    fn sem(map: &SemMap, k: &str, n: usize) -> Arc<tokio::sync::Semaphore> {
        map.lock().entry(k.to_string()).or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(n))).clone()
    }

    async fn acquire(&self, cluster: &str, via: Option<&str>) -> Vec<tokio::sync::OwnedSemaphorePermit> {
        let mut held = Vec::with_capacity(3);
        let mut sems = vec![Self::sem(&self.per_cluster, cluster, ES_PER_CLUSTER)];
        if let Some(v) = via {
            sems.push(Self::sem(&self.per_jump, v, ES_PER_JUMP));
        }
        sems.push(self.global.clone());
        for s in sems {
            // These semaphores are never closed, so acquiring cannot fail.
            if let Ok(p) = s.acquire_owned().await {
                held.push(p);
            }
        }
        held
    }
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
}

/// Where the hosted core keeps its last cluster setup, so a restart does not leave every
/// non-admin looking at "not primed" until an admin happens to open the app.
const PRIMED_FILE: &str = "primed.json";

/// The first account's password before every install got its own. Kept only to warn an
/// existing install that has still not changed it; nothing is ever created with it.
const LEGACY_SHIPPED_PASSWORD: &str = "loginme";

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
        let first_pw_file = auth_path(auth::INITIAL_PASSWORD_FILE);
        // A fresh install gets the first account rather than an empty state and a
        // bootstrap screen, with a password made for this install alone. It is created
        // must_change, so it is a way in and nothing more.
        if edition.uses_accounts() {
            let override_file = std::env::var_os(auth::INITIAL_PASSWORD_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from);
            if let Some(seeded) = auth::seed_first_account(&users, first_pw_file.as_deref(), override_file.as_deref()) {
                Core::log_seeded(&seeded, override_file.as_deref());
            } else {
                if auth::retire_initial_password_file(&users, first_pw_file.as_deref()) {
                    tracing::info!("removed {}: the first password has been changed", auth::INITIAL_PASSWORD_FILE);
                }
                // An install from before per-install passwords whose first account was
                // never signed in to still opens with the password that shipped in the
                // source. Left as it is — nothing here rewrites an existing accounts
                // file — but said out loud on every start until someone changes it.
                if users.default_unchanged() && users.verify(auth::DEFAULT_USER, LEGACY_SHIPPED_PASSWORD).is_ok() {
                    tracing::warn!(
                        user = auth::DEFAULT_USER,
                        "the first account still has the password older versions shipped with; \
                         sign in and change it now — anyone who reaches the sign-in page can use it"
                    );
                }
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
        let data_dir_for_fleet = data_dir.clone();
        let data_dir_for_notify = data_dir.clone();
        Arc::new(Core {
            edition,
            users,
            sessions: Sessions::default(),
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
            started: std::time::Instant::now(),
            delay_sink: RwLock::new(Sink {
                config: read_sink_config(data_dir_for_sink.as_deref(), edition),
                state: SinkState::default(),
            }),
            zbx,
            zbx_api: RwLock::new(zbx_api),
            zbx_link,
            vault,
            zbx_sync: RwLock::new(ZbxSync::default()),
            zbx_writer,
            vault_writer,
            zbx_metrics_cache: parking_lot::Mutex::new(HashMap::new()),
            fleet: crate::fleet::Fleet::new(data_dir_for_fleet.as_deref()),
            es_limits: EsLimits::from_env(),
            notify: crate::notify::NotifyStore::open(data_dir_for_notify.map(|d| d.join("notifications.json"))),
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

    /// The file holding the first password until it is changed; accounts editions only.
    fn initial_password_file(&self) -> Option<PathBuf> {
        self.data_dir.as_ref().filter(|_| self.edition.uses_accounts()).map(|d| d.join(auth::INITIAL_PASSWORD_FILE))
    }

    /// The one startup line that announces the first account. Its wording ("created the
    /// first one") is what the docs tell operators to grep for.
    ///
    /// The log, not the sign-in page: whoever can read this already has the server;
    /// whoever loads the page has not. It is printed once, on the start that creates the
    /// account.
    fn log_seeded(s: &auth::Seeded, override_file: Option<&std::path::Path>) {
        if let Some(why) = &s.override_error {
            tracing::error!(
                "{} not used ({why}); a random first password was generated instead",
                auth::INITIAL_PASSWORD_ENV
            );
        }
        if let Some(why) = &s.save_error {
            tracing::error!("the first account could not be saved and lasts only until restart: {why}");
        }
        if let Some(why) = &s.write_error {
            tracing::error!("{why} — the first password is in this log only");
        }
        match (&s.generated, &s.written_to) {
            (Some(pw), Some(file)) => tracing::warn!(
                user = auth::DEFAULT_USER,
                password = %pw,
                file = %file.display(),
                "no accounts existed: created the first one. Sign in with this password (also in \
                 the file named here, removed once you change it) and set a real password — \
                 nothing else works until you do."
            ),
            (Some(pw), None) => tracing::warn!(
                user = auth::DEFAULT_USER,
                password = %pw,
                "no accounts existed: created the first one. Sign in with this password and set a \
                 real password — nothing else works until you do."
            ),
            (None, _) => tracing::warn!(
                user = auth::DEFAULT_USER,
                from = %override_file.map(|p| p.display().to_string()).unwrap_or_default(),
                "no accounts existed: created the first one, with the password from {}. Sign in and \
                 set a real password — nothing else works until you do.",
                auth::INITIAL_PASSWORD_ENV
            ),
        }
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
    pub async fn handle_as_from(self: &Arc<Self>, msg: Value, caller: Option<Caller>, reauth: Reauth) -> Value {
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
            "USER_LIST" | "USER_ADD" | "USER_REMOVE" | "USER_SET_ROLE" | "USER_SET_PASSWORD" => {
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
                self.forget_persisted_prime();
                self.set_writes_unlocked(false);
                self.transport.forget_clients();
                self.close_tunnels().await;
                json!({ "ok": true })
            }
            "ES" => self.es(msg).await,
            "FLEET_STATE" => self.fleet_state_msg(&msg, caller.as_ref()),
            "CLUSTER_DATASET" => self.cluster_dataset_msg(&msg, caller.as_ref()).await,
            "REFRESH" => self.refresh_msg(&msg, caller.as_ref()),
            "EVENTS_TICKET" => self.events_ticket_msg(caller.clone(), reauth),
            "DELAY_SINK_GET" | "DELAY_SINK_SET" | "DELAY_SINK_RUN" => self.delay_sink_msg(&t, &msg).await,
            "NOTIFY_PUT" | "NOTIFY_LIST" | "NOTIFY_CLEAR" => self.notify_msg(&t, &msg, caller.as_ref()),
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
                        self.transport.forget_clients();
                        json!({ "ok": true, "host": host, "sha256": fp })
                    }
                    _ => json!({ "ok": false, "message": "no certificate has been seen for that host yet" }),
                }
            }
            "UNTRUST_CERT" => {
                let host = msg.get("host").and_then(|v| v.as_str()).unwrap_or("");
                self.pins.untrust_cert(host);
                self.transport.forget_clients();
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
                        self.transport.forget_clients();
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
            "PINS" => json!({ "ok": true, "pins": self.pins_for(caller.as_ref()) }),
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
                let tmp = p.with_extension("tmp");
                if let Some(dir) = p.parent() {
                    let _ = tokio::fs::create_dir_all(dir).await;
                }
                if let Err(e) = tokio::fs::write(&tmp, text).await {
                    return json!({ "ok": false, "message": format!("cannot write {}: {e}", tmp.display()) });
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    // 0600 for a file being created, but never a downgrade of one that
                    // already exists. Forcing it unconditionally meant saving from the UI
                    // silently locked the operator out of their own config file — the
                    // hosted stack deliberately shares it between the container and the
                    // host user, and one write reset that to owner-only.
                    let mode = std::fs::metadata(&p)
                        .map(|m| m.permissions().mode() & 0o777)
                        .unwrap_or(0o600);
                    let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
                }
                match tokio::fs::rename(&tmp, &p).await {
                    Ok(_) => json!({ "ok": true, "path": path, "bytes": text.len(), "keptVersion": kept }),
                    Err(e) => json!({ "ok": false, "message": format!("cannot replace {path}: {e}") }),
                }
            }
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

    /// Requests sent to each cluster in the last `REQUEST_WINDOW`, plus the rate that
    /// implies. Old entries are dropped as they age out, so memory stays flat.
    pub fn request_stats(&self) -> Value {
        let now = std::time::Instant::now();
        let mut log = self.request_log.lock();
        let mut out = serde_json::Map::new();
        for (cluster, q) in log.iter_mut() {
            while q.front().map(|t| now.duration_since(*t) > REQUEST_WINDOW).unwrap_or(false) {
                q.pop_front();
            }
            let n = q.len();
            let secs = REQUEST_WINDOW.as_secs_f64();
            out.insert(cluster.clone(), json!({
                "last5m": n,
                "perMinute": (n as f64) / (secs / 60.0),
                "perSecond": (n as f64) / secs,
            }));
        }
        json!({ "windowSec": REQUEST_WINDOW.as_secs(), "clusters": out })
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
                // One shape for "who is this", built from the account rather than
                // assembled by hand here and differently somewhere else.
                let who = Caller { name: acct.name.clone(), role: acct.role, must_change: acct.must_change, scope: acct.scope.clone() };
                json!({ "ok": true, "session": token, "caller": who.public() })
            }
            Err(e) => {
                // The name is logged; the reason is not narrowed for the caller, so a
                // failed login never confirms which half was wrong.
                tracing::warn!(target: "audit", user = %name, "login refused");
                json!({ "ok": false, "kind": "bad_credentials", "message": e.to_string() })
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
            Err(e) => json!({ "ok": false, "kind": "bad_request", "message": e.to_string() }),
        };

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
                    // Removing the first account also retires its first password.
                    let _ = auth::retire_initial_password_file(&self.users, self.initial_password_file().as_deref());
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
                let out = done(self.users.set_role(&name, role));
                if out["ok"] == json!(true) {
                    self.sessions.end_all_for(&name);
                    tracing::info!(target: "audit", user = %me, subject = %name, role = role.as_str(), "role changed");
                }
                out
            }
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
                    // The first password has done its job; its copy on disk goes now.
                    if auth::retire_initial_password_file(&self.users, self.initial_password_file().as_deref()) {
                        tracing::info!(target: "audit", user = %me, "removed {}: the first password has been changed",
                                       auth::INITIAL_PASSWORD_FILE);
                    }
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
                if role.may_write() {
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
        m.insert(
            "defaultConfigPath".into(),
            if admin { json!(self.data_dir.as_ref().map(|d| d.join("config_cluster.json"))) } else { Value::Null },
        );
        m.insert("tunnels".into(), json!(tunnels));
        m.insert("zabbixSso".into(), json!(self.zbx.configured()));
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

    /// Trust decisions, less the hosts that belong to clusters this caller cannot see.
    fn pins_for(&self, caller: Option<&Caller>) -> Value {
        let mut all = self.pins.list();
        let Some(ids) = self.visible_ids(caller) else { return all };
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

    /// The cluster list for somebody who may not read the config file: credentials
    /// removed, and only the clusters they may see.
    ///
    /// Read from the file the hosted core was started with — never from a path the caller
    /// names, which would make this a way to read any file the core can.
    /// The server's own config file, parsed — YAML or JSON, decided by content. The error is
    /// a ready refusal. Read from the path the core was started with and no other.
    async fn read_config_file(&self) -> Result<Value, Value> {
        let Some(path) = self.config_hint.clone() else {
            return Err(json!({ "ok": false, "kind": "no_config",
                               "message": "this server was started without a config file (ELASTICPRO_CONFIG)" }));
        };
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(json!({ "ok": false, "kind": "not_found",
                                   "message": "no clusters are configured yet — an admin has to add one first" }))
            }
            Err(e) => return Err(json!({ "ok": false, "kind": "io_error", "message": format!("cannot read the config: {e}") })),
        };
        let t = text.trim_start_matches('\u{feff}');
        let parsed: Result<Value, String> = if t.trim_start().starts_with('{') {
            serde_json::from_str(t).map_err(|e| e.to_string())
        } else {
            serde_yaml::from_str(t).map_err(|e| e.to_string())
        };
        parsed.map_err(|e| json!({ "ok": false, "kind": "parse_error", "message": format!("the config does not parse: {e}") }))
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
        let token = self.sessions.begin(&acct);
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
        if self.edition != Edition::Hosted {
            return (404, json!({ "ok": false, "message": "not available in this build" }));
        }
        if !self.zbx_link.source_ok(source) {
            let s = source.map(|s| s.to_string()).unwrap_or_else(|| "unknown".into());
            tracing::warn!(target: "audit", source = %s, "zabbix sign-in refused: source not in allowedSources");
            return (403, json!({ "ok": false, "kind": "forbidden", "message": "this source may not sign in through Zabbix" }));
        }
        if !self.zbx_link.rate_ok("sso", source, crate::zbx_link::SSO_PER_MIN) {
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
        let role = zbx_sso::role_for(claim.zabbix_user_type).expect("verify refuses a type with no role");
        let scope = zbx_sso::scope_for(role, &claim.groups);
        let name = zbx_sso::account_name(&claim.username);
        match self.users.upsert_external(&name, zbx_sso::SOURCE, role, scope.clone()) {
            Ok(acct) => {
                // A session already open under this name keeps the role it started with
                // unless it is told; Zabbix having just said otherwise is the telling.
                self.sessions.refresh_for(&acct.name, acct.role, acct.scope.clone());
                let code = self.zbx.issue_code(&acct.name);
                tracing::info!(target: "audit", user = %acct.name, role = acct.role.as_str(),
                               groups = ?claim.groups, "zabbix sign-in code issued");
                (200, json!({ "ok": true, "sso_code": code, "account": acct.name, "role": acct.role.as_str(),
                              "scoped": acct.scope.is_some() }))
            }
            Err(auth::AuthError::Exists(n)) => {
                tracing::warn!(target: "audit", user = %n, "zabbix sign-in refused: a local account has that name");
                (409, json!({ "ok": false, "kind": "name_taken",
                              "message": format!("a local ElasticPro account is already called {n}; it will not be taken over by a Zabbix sign-in") }))
            }
            Err(auth::AuthError::BadCredentials) => {
                tracing::warn!(target: "audit", user = %name, "zabbix sign-in refused: account disabled here");
                (403, json!({ "ok": false, "kind": "disabled",
                              "message": format!("{name} is disabled in ElasticPro") }))
            }
            Err(e) => (500, json!({ "ok": false, "kind": "io_error", "message": e.to_string() })),
        }
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
        let p: PrimeMsg = match serde_json::from_value(msg.clone()) {
            Ok(p) => p,
            Err(e) => return json!({ "ok": false, "message": format!("bad PRIME: {e}") }),
        };
        let mut incoming = p.clusters;
        let (held, effective) = {
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
            cur.read_only = p.read_only != Some(false);
            match p.shared_auth_header.as_deref() {
                None => {}
                Some("") => cur.shared_auth = None,
                Some(h) => cur.shared_auth = Some(h.to_string()),
            }
            let mut held: Vec<String> = cur.clusters.values()
                .filter(|c| c.auth_header.as_deref().is_some_and(|a| !a.is_empty()))
                .map(|c| c.id.clone()).collect();
            held.sort();
            let mut effective: Vec<ClusterSpec> = cur.clusters.values().cloned().collect();
            effective.sort_by(|a, b| a.id.cmp(&b.id));
            (held, effective)
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
        self.transport.forget_clients();

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
        json!({ "ok": true, "count": p.clusters.len(), "readOnly": p.read_only, "tunnels": n_t, "held": held })
    }

    async fn es(self: &Arc<Self>, msg: Value) -> Value {
        let req: EsRequest = match serde_json::from_value(msg) {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "kind": "bad_message", "message": format!("bad ES request: {e}") }),
        };
        self.es_req(req).await
    }

    /// The same path a page's request takes, entered with a request that was built here
    /// rather than parsed from a message. Used by the scheduled delay measurement, so
    /// that job inherits the jump hosts, the pinned certificates, the credentials and
    /// the read-only guard instead of carrying its own copy of any of them.
    pub(crate) async fn es_req(self: &Arc<Self>, req: EsRequest) -> Value {
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
        let _permits = self.es_limits.acquire(&req.cluster_id, via.as_deref()).await;
        let route = Route { tunnel: tunnel.as_ref().map(|(t, p)| (t, *p)), tls: TlsMode::parse(tls.as_deref()) };
        let writes = Writes::decide(read_only, self.writes_unlocked(), req.allow_writes);
        let out = self.transport.request(&req, &url, auth.as_deref(), writes, route).await;
        // Only requests that actually went to the cluster count as load on it.
        if out.get("kind").and_then(|k| k.as_str()) != Some("blocked_readonly") {
            self.record_request(&req.cluster_id);
        }
        // A write that went through makes some of the fleet cache out of date.
        if out.get("ok") == Some(&json!(true)) && !crate::guard::is_read(&req.method, &req.path) {
            self.fleet_invalidate(&req.cluster_id, &req.method, &req.path);
        }
        out
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
        let (found, skipped) = if provisioned.iter().any(|p| p.starts_with("created")) {
            zapi.clusters().await.unwrap_or(fetched)
        } else {
            fetched
        };
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
                    notes.push("password is a Secret macro, which Zabbix never returns — make it a Vault macro".into());
                    ("secret-macro", None)
                }
                PasswordRef::Missing => ("none", None),
            } };
            let mut auth = if opts.use_elasticpro_credentials { own.clone() } else { secret.as_ref().map(|p| {
                use base64::Engine as _;
                format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", c.username, p)))
            }) };
            // The last good password carries on only through a Vault outage. ElasticPro's own
            // credential is local and definite: when it is gone, an admin removed it.
            if auth.is_none() && credential != "none" && !opts.use_elasticpro_credentials {
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
            specs.insert(id.clone(), ClusterSpec {
                id: id.clone(), name: Some(c.name.clone()), url: c.url.clone(), auth_header: auth, via: via.clone(), tls: None,
                zabbix_groups: c.readers.clone(), log_index_pattern: None,
            });
            view.push(json!({
                "_id": id, "name": c.name, "url": c.url, "via": via, "source": "zabbix",
                "zabbixHost": c.host, "zabbixHostId": c.hostid, "client": c.client,
                "zabbixGroups": c.readers, "username": c.username,
                "credential": credential, "credentialOk": usable, "notes": notes,
            }));
        }
        view.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let n = specs.len();
        {
            let mut z = self.zbx_sync.write();
            z.specs = specs;
            z.view = view;
            z.last_ok = Some(auth::now());
            z.error = None;
            z.skipped = skipped.clone();
            z.options = opts.clone();
            z.provisioned = provisioned.clone();
        }
        self.transport.forget_clients();
        tracing::info!(target: "audit", clusters = n, skipped = skipped.len(), problems,
                       credentials = if opts.use_elasticpro_credentials { "elasticpro" } else { "zabbix" }, "zabbix sync");
        json!({ "ok": true, "clusters": n, "skipped": skipped, "problems": problems, "provisioned": provisioned,
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
    async fn zabbix_metrics(&self, msg: &Value) -> Value {
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
        match self.zbx_api().latest(&hostid, &keys).await {
            Ok(v) => {
                let mut c = self.zbx_metrics_cache.lock();
                c.retain(|_, (at, _)| at.elapsed() < std::time::Duration::from_secs(120));
                c.insert(cache_key, (std::time::Instant::now(), v.clone()));
                json!({ "ok": true, "items": v, "now": auth::now() })
            }
            Err(e) => json!({ "ok": false, "kind": "zabbix_error", "message": e }),
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
                        self.transport.forget_clients();
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
