//! Accounts, roles and sessions — for the installed builds only.
//!
//! The portable edition is deliberately untouched by all of this. Someone running the
//! portable build has the executable, the config file and the data folder in their hand
//! already; a login screen in front of files they can read with Notepad would be theatre,
//! and it would break the one property that makes the portable build worth having — copy
//! it to a machine, run it, no setup. `Edition::Portable` short-circuits every check here
//! to "allowed", and no accounts file is ever created.
//!
//! Where accounts do exist, three roles, and the difference between them is what they can
//! reach rather than how much they are trusted to be careful:
//!
//! * **admin** — everything, and the only role that can write to Elasticsearch at all.
//! * **user** — read-only across every page. Sees index names, snapshots, the volume
//!   report; cannot unlock writes, read the config, or touch a credential.
//! * **guest** — the dashboard and nothing else. No index names, because index names in
//!   this product routinely carry customer and project names, and a guest account is the
//!   one you hand to somebody outside the team.
//!
//! A password is stored as PBKDF2-HMAC-SHA512 over a random per-account salt, at the same
//! 600 000 rounds `crypto.rs` uses to seal config secrets. Unlike a cluster credential, a
//! login password never has to be replayed to anything, so hashing it is enough and
//! nothing here can be decrypted back.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;

/// Matches `crypto.rs`. Login is not a hot path; the cost is the point.
pub const ROUNDS: u32 = 600_000;

/// How long a session survives without being used.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(8 * 3600);

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Compare without letting the time taken reveal how much of the hash matched.
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/* ---------------------------------- edition ---------------------------------- */

/// Which build this is, which decides whether accounts exist at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    /// Everything beside the exe, no install, no accounts. Unchanged by this module.
    Portable,
    /// Installed per-user or per-machine. Accounts apply.
    Installed,
    /// `elasticpro-bridge` serving many people over HTTP. Accounts and API tokens apply.
    Hosted,
}

impl Edition {
    /// Portable is the only edition with no accounts. Keeping this one predicate means
    /// the answer cannot drift between the places that ask.
    pub fn uses_accounts(self) -> bool {
        !matches!(self, Edition::Portable)
    }
    /// API tokens need something listening. The desktop app is Tauri IPC and has no
    /// socket to offer, so tokens exist only where a bridge is actually serving.
    pub fn uses_api_tokens(self) -> bool {
        matches!(self, Edition::Hosted)
    }
    /// Whether this build may run work on a timer. Only the hosted bridge is a daemon;
    /// the desktop editions exist while somebody has the app open, so a schedule there
    /// would be a promise kept only by accident. Separate from `uses_api_tokens` even
    /// though both are currently Hosted-only: one is about a socket, this is about
    /// still being alive at three in the morning.
    pub fn schedules(self) -> bool {
        matches!(self, Edition::Hosted)
    }
}

/* ----------------------------------- roles ----------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Guest,
    User,
    /// Reads everything and may write to a cluster, behind the same write unlock an admin
    /// uses — but never touches accounts, secrets or the config. What a Zabbix Admin
    /// becomes here: somebody who runs the clusters without administering this app.
    Operator,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Guest => "guest",
            Role::User => "user",
            Role::Operator => "operator",
            Role::Admin => "admin",
        }
    }
    pub fn parse(s: &str) -> Option<Role> {
        match s.trim().to_ascii_lowercase().as_str() {
            "admin" => Some(Role::Admin),
            // "viewer" and "operator" are the names deploy/db/init.sql used while this
            // was still a plan. Accepted on the way in so an early row still resolves.
            "user" | "viewer" => Some(Role::User),
            "guest" => Some(Role::Guest),
            // It meant admin while it was only a name in a plan; it is its own role now.
            "operator" => Some(Role::Operator),
            _ => None,
        }
    }
    /// Operators and admins may write to a cluster. Stated once, here, so no call site
    /// invents it. Writing still needs the guard unlocked and a person acting — this is
    /// only whether the role may ask.
    pub fn may_write(self) -> bool {
        matches!(self, Role::Operator | Role::Admin)
    }
}

/// Whether an account limited to `scope` may see a cluster tagged with `cluster_groups`.
///
/// `None` is an unscoped account — every local account, and every Zabbix Admin and Super
/// admin — and sees everything. `Some` is a list of Zabbix user groups: the cluster is
/// visible when it names at least one of them. A scoped account in no mapped group sees
/// nothing, which is the point: the default for someone Zabbix has not placed is no
/// clusters, not all of them.
///
/// The one definition. The request gate, the cluster list and every per-cluster fact the
/// core hands back all ask this, so what a person can see and what they can query cannot
/// drift apart.
pub fn scope_allows(scope: Option<&[String]>, cluster_groups: &[String]) -> bool {
    match scope {
        None => true,
        Some(mine) => cluster_groups
            .iter()
            .any(|g| mine.iter().any(|m| m.trim().eq_ignore_ascii_case(g.trim()) && !m.trim().is_empty())),
    }
}

/* ------------------------------- what a role may do ------------------------------ */

/// The ES paths a guest may read.
///
/// An allowlist rather than a blocklist: a new Elasticsearch endpoint, or one nobody
/// thought of, must default to refused. Everything here is fleet-level health with no
/// index name in the response.
const GUEST_READS: &[&str] = &[
    "/",
    "/_cluster/health",
    "/_cluster/stats",
    "/_cat/health",
    "/_cat/nodes",
    "/_cat/allocation",
    "/_cat/master",
    "/_nodes",
];

/// Does this path match an allowlist entry exactly, or as a path prefix?
///
/// `/_cat/nodes` must allow `/_cat/nodes?h=name` and `/_nodes/stats/fs`, but must not
/// allow `/_cat/nodesomething`.
fn path_allowed(path: &str, allow: &[&str]) -> bool {
    let bare = path.split('?').next().unwrap_or("/").trim_end_matches('/');
    let bare = if bare.is_empty() { "/" } else { bare };
    // A proxy that resolves `..` could walk out of an allowed prefix. Nothing legitimate
    // needs it, so it is refused rather than normalised.
    if bare.contains("..") {
        return false;
    }
    allow.iter().any(|a| {
        let a = a.trim_end_matches('/');
        if a.is_empty() {
            return bare == "/";
        }
        bare == a || bare.starts_with(&format!("{a}/"))
    })
}

pub fn guest_may_read(path: &str) -> bool {
    path_allowed(path, GUEST_READS)
}

/// The minimum role a message type needs, or `None` when no session is required.
///
/// `None` is deliberately tiny: PING is how the UI discovers that a login is needed in
/// the first place, so it has to answer before anyone has one.
pub fn required_role(msg_type: &str) -> Option<Role> {
    match msg_type {
        // Answers "who am I and do I need to log in" — must work unauthenticated.
        "PING" => None,
        // Harmless no-ops the shell calls on startup.
        "BADGE" | "OPEN_APP" | "ENABLE_NET_ERRORS" => None,
        // Authentication itself.
        "LOGIN" | "LOGOUT" | "WHOAMI" => None,

        // Reading a cluster. The method and path decide the rest; see authorize().
        "ES" => Some(Role::Guest),
        // The cluster list with every credential taken out, and only the clusters this
        // caller may see. How anybody who is not an admin gets a config at all.
        "CONFIG_VIEW" => Some(Role::Guest),
        // Exchanging a one-time Zabbix sign-in code is how a session starts, so it cannot
        // need one.
        "SSO_EXCHANGE" => None,
        // Clusters that are Zabbix hosts, credentials removed and filtered by scope.
        "ZABBIX_CLUSTERS" => Some(Role::Guest),
        // What Zabbix last measured on a cluster's host — health and counts, no index names.
        "ZABBIX_METRICS" => Some(Role::Guest),
        // Asking Zabbix and Vault again, now. It changes which clusters exist.
        "ZABBIX_SYNC" => Some(Role::Admin),
        // The Zabbix connection itself: its address, its token, pairing. Changes where a
        // secret is sent and who can sign in, so nothing below admin reads or touches it.
        "ZABBIX_LINK_GET" | "ZABBIX_LINK_SET" | "ZABBIX_LINK_TEST" | "ZABBIX_PAIR_BEGIN" | "ZABBIX_UNPAIR" => Some(Role::Admin),

        // The fleet cache: what the core's poller last read from each cluster. The same
        // facts ES reads return, so the same floor; which datasets a guest gets and which
        // clusters anybody gets are decided per cluster in the handler and the gate.
        "FLEET_STATE" | "CLUSTER_DATASET" | "EVENTS_TICKET" => Some(Role::Guest),
        // Asking the poller to go to the clusters now. Load on every cluster named, so not
        // for a guest's dashboard to trigger.
        "REFRESH" => Some(Role::User),

        // Fleet facts with no index names, but they name hosts and jump hosts.
        "TUNNELS" | "PINS" | "REQUEST_STATS" => Some(Role::User),
        // Listing the archive names object keys, which carry client and branch names —
        // the same shape of fact as an index name, and gated the same way.

        // Everything below either writes, or hands back something secret.
        // CONFIG_READ returns the raw config, which carries cluster credentials.
        "CONFIG_READ" | "CONFIG_WRITE" | "FILE_WRITE" => Some(Role::Admin),
        "PRIME" | "FORGET" => Some(Role::Admin),
        // Operators write to clusters, so they unlock the guard to do it. The guard is
        // still one switch for the whole process, and still resets on restart.
        "WRITE_UNLOCK" => Some(Role::Operator),
        "SEAL" | "OPEN" => Some(Role::Admin),
        "VAULT_GET" | "VAULT_SET" | "VAULT_DEL" => Some(Role::Admin),
        "TRUST_CERT" | "UNTRUST_CERT" | "TRUST_HOSTKEY" | "UNTRUST_HOSTKEY" => Some(Role::Admin),
        "TUNNEL_SECRET" | "TUNNEL_RECONNECT" => Some(Role::Admin),
        "USER_LIST" | "USER_ADD" | "USER_REMOVE" | "USER_SET_ROLE" | "USER_SET_PASSWORD" => Some(Role::Admin),
        // Uploading a private key, and every version of a config that has held
        // credentials. Nothing below admin goes near either.
        "KEY_UPLOAD" | "KEY_LIST" | "KEY_DELETE" => Some(Role::Admin),
        "CONFIG_HISTORY" | "CONFIG_RESTORE" => Some(Role::Admin),
        "TOKEN_LIST" | "TOKEN_CREATE" | "TOKEN_REVOKE" => Some(Role::Admin),
        // Arming the scheduled measurement decides that this process will write
        // to a cluster unattended. Nothing below admin goes near it.
        "DELAY_SINK_GET" | "DELAY_SINK_SET" | "DELAY_SINK_RUN" => Some(Role::Admin),

        // The caller's own notification history. Not a write to any cluster, so no write
        // unlock; anybody signed in, and the handler only ever uses the caller's own name.
        "NOTIFY_PUT" | "NOTIFY_LIST" | "NOTIFY_CLEAR" => Some(Role::Guest),

        // Anything new is refused until somebody decides where it belongs.
        _ => Some(Role::Admin),
    }
}

/// Whether `role` may send this message, and why not when it may not.
///
/// `method` and `path` matter only for ES: the role decides whether a write is possible
/// at all, and for a guest the path decides whether the read is.
pub fn authorize(role: Role, msg_type: &str, method: &str, path: &str) -> Result<(), String> {
    let needed = match required_role(msg_type) {
        None => return Ok(()),
        Some(r) => r,
    };
    if role < needed {
        return Err(format!(
            "{} is not available to the {} role",
            msg_type,
            role.as_str()
        ));
    }
    if msg_type != "ES" {
        return Ok(());
    }

    let m = method.trim().to_ascii_uppercase();
    let is_read = m.is_empty() || m == "GET" || m == "HEAD";
    if !is_read && !role.may_write() {
        return Err(format!(
            "{m} requests are not available to the {} role — only an operator or admin can write to a cluster",
            role.as_str()
        ));
    }
    if role == Role::Guest && !guest_may_read(path) {
        return Err(format!(
            "the guest role can see cluster health only, not {}",
            path.split('?').next().unwrap_or(path)
        ));
    }
    Ok(())
}

/// Who is asking, once their session token or API token has been resolved.
///
/// Built by whoever knows the transport — the Tauri shell from the message's `session`
/// field, the hosted bridge from an `Authorization: Bearer` header — so the message
/// handler itself never has to care which one it was.
#[derive(Clone, Debug)]
pub struct Caller {
    pub name: String,
    pub role: Role,
    /// True while this account is still on the password it shipped with.
    pub must_change: bool,
    /// The Zabbix user groups this caller is limited to, or `None` for every cluster.
    /// See `scope_allows`.
    pub scope: Option<Vec<String>>,
}

impl Caller {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name, "role": self.role.as_str(), "mustChange": self.must_change,
            "scoped": self.scope.is_some(),
        })
    }
    /// May this caller see a cluster tagged with these Zabbix groups?
    pub fn sees(&self, cluster_groups: &[String]) -> bool {
        scope_allows(self.scope.as_deref(), cluster_groups)
    }
}

/* ---------------------------------- accounts ---------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account {
    pub name: String,
    pub role: Role,
    /// hex, per account.
    salt: String,
    /// hex PBKDF2-HMAC-SHA512 output.
    hash: String,
    rounds: u32,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub disabled: bool,
    /// Set on the seeded account. Until it is cleared the session may only change this
    /// password, which is what makes shipping a known one acceptable.
    #[serde(default)]
    pub must_change: bool,
    /// Where this account comes from. `None` is a local account with a password here;
    /// `Some("zabbix")` was created by a Zabbix sign-in and has no usable password — its
    /// role and scope are rewritten from Zabbix every time that person signs in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Zabbix user groups this account is limited to; `None` sees every cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<String>>,
}

impl Account {
    /// What an admin is allowed to see about an account. Never the hash or the salt:
    /// they are of no use to the UI and every copy is one more place to leak from.
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "role": self.role.as_str(),
            "createdAt": self.created_at,
            "disabled": self.disabled,
            "mustChange": self.must_change,
            "source": self.source,
            "scope": self.scope,
        })
    }
}

fn derive(password: &str, salt_hex: &str, rounds: u32) -> String {
    let salt = hex::decode(salt_hex).unwrap_or_default();
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha512>(password.as_bytes(), &salt, rounds, &mut out);
    hex::encode(out)
}

#[derive(Debug, PartialEq)]
pub enum AuthError {
    /// Wrong name, wrong password, or a disabled account — one message for all three, so
    /// a failed login never confirms that a name exists.
    BadCredentials,
    Exists(String),
    NotFound(String),
    /// Refused rather than allowed: an accounts file with no admin cannot be administered.
    LastAdmin,
    Weak(String),
    Io(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::BadCredentials => write!(f, "that username and password do not match an account"),
            AuthError::Exists(n) => write!(f, "an account named {n} already exists"),
            AuthError::NotFound(n) => write!(f, "no account named {n}"),
            AuthError::LastAdmin => write!(f, "this is the only admin account — promote another before removing or demoting it"),
            AuthError::Weak(why) => write!(f, "{why}"),
            AuthError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// The shortest password worth calling one. Long enough to matter, short enough that
/// nobody writes it on a sticky note.
pub const MIN_PASSWORD: usize = 10;

/// The account a fresh install starts with.
///
/// Its password is made for this install alone (see [`seed_first_account`]): a password
/// that ships in the source is one anybody can type, and whoever reached the sign-in page
/// before the administrator did could take the account. The account is still created with
/// `must_change` set, and a session holding it can do nothing at all except replace it.
pub const DEFAULT_USER: &str = "elasticpro";

/// The file in the data directory that holds the first password until it is changed.
/// Written 0600, once, on the start that creates the account; removed as soon as the
/// account's password is changed.
pub const INITIAL_PASSWORD_FILE: &str = "initial-admin-password";

/// Names a file to take the first password from instead of generating one. A file and
/// never the password itself: an environment variable shows up in `docker inspect`,
/// `/proc/<pid>/environ` and every child process.
pub const INITIAL_PASSWORD_ENV: &str = "ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE";

/// No 0/O, 1/l/I: the password is read off a terminal and typed by hand.
const INITIAL_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/// 24 characters of a 57-letter alphabet, about 140 bits.
const INITIAL_LEN: usize = 24;

/// A fresh first password, from the operating system's CSPRNG.
pub fn generate_initial_password() -> String {
    use rand::Rng;
    let mut rng = rand::rngs::OsRng;
    (0..INITIAL_LEN)
        .map(|_| INITIAL_ALPHABET[rng.gen_range(0..INITIAL_ALPHABET.len())] as char)
        .collect()
}

/// The password in an operator's override file: its first line, line ending dropped,
/// held to the same minimum as any password change.
pub fn read_initial_password_file(path: &std::path::Path) -> Result<String, AuthError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AuthError::Io(format!("cannot read {}: {e}", path.display())))?;
    let pw = raw.lines().next().unwrap_or("").to_string();
    check_password(&pw)?;
    Ok(pw)
}

/// Write `password` to `path` readable by the owner only, by temp file and rename so a
/// crash never leaves half a password or a copy with looser permissions.
fn write_secret_file(path: &std::path::Path, password: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(password.as_bytes())?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

/// What [`seed_first_account`] did, for the caller to log.
#[derive(Debug)]
pub struct Seeded {
    /// The password, when it was generated here. `None` when it came from the operator's
    /// file — they already have it, and it is not ours to print.
    pub generated: Option<String>,
    /// Where the generated password was written, when it was.
    pub written_to: Option<PathBuf>,
    /// Why the generated password could not be written to the data directory.
    pub write_error: Option<String>,
    /// Why the operator's override file was not used (a random password was made instead).
    pub override_error: Option<String>,
    /// Why the accounts file could not be saved (the account exists for this run only).
    pub save_error: Option<String>,
}

/// Create the first account when there are none; `None` when accounts already exist.
///
/// `password_file`: where to leave a generated password (`None` = memory only, log it
/// only). `override_file`: the operator's [`INITIAL_PASSWORD_ENV`] file, if set.
///
/// An override that cannot be used falls back to a generated password rather than to no
/// account at all: an empty accounts store offers `BOOTSTRAP_ADMIN` to whoever asks first,
/// which is the very race this replaces.
pub fn seed_first_account(users: &UserStore, password_file: Option<&std::path::Path>,
                          override_file: Option<&std::path::Path>) -> Option<Seeded> {
    if !users.is_empty() {
        return None;
    }
    let mut out = Seeded { generated: None, written_to: None, write_error: None, override_error: None, save_error: None };
    let from_operator = match override_file.map(read_initial_password_file) {
        Some(Ok(pw)) => Some(pw),
        Some(Err(e)) => {
            out.override_error = Some(e.to_string());
            None
        }
        None => None,
    };
    let password = match from_operator {
        Some(pw) => pw,
        None => {
            let pw = generate_initial_password();
            out.generated = Some(pw.clone());
            pw
        }
    };
    if let Err(e) = users.add_inner(DEFAULT_USER, &password, Role::Admin, true, false) {
        if users.is_empty() {
            return None;
        }
        out.save_error = Some(e.to_string());
    }
    if let (Some(pw), Some(path)) = (&out.generated, password_file) {
        match write_secret_file(path, pw) {
            Ok(()) => out.written_to = Some(path.to_path_buf()),
            Err(e) => out.write_error = Some(format!("cannot write {}: {e}", path.display())),
        }
    }
    Some(out)
}

/// Remove the first-password file once it no longer opens anything: the account's
/// password was changed, or the account is gone. True when a file was removed.
pub fn retire_initial_password_file(users: &UserStore, path: Option<&std::path::Path>) -> bool {
    match path {
        Some(p) if p.exists() && !users.default_unchanged() => std::fs::remove_file(p).is_ok(),
        _ => false,
    }
}

fn check_password(p: &str) -> Result<(), AuthError> {
    if p.chars().count() < MIN_PASSWORD {
        return Err(AuthError::Weak(format!(
            "the password must be at least {MIN_PASSWORD} characters"
        )));
    }
    Ok(())
}

/// Accounts on disk, as `users.json` in the data directory.
///
/// `None` for the path means memory only, which is what the tests and the portable
/// edition get.
pub struct UserStore {
    path: Option<PathBuf>,
    rounds: u32,
    accounts: RwLock<Vec<Account>>,
}

impl UserStore {
    pub fn open(path: Option<PathBuf>) -> UserStore {
        Self::open_with_rounds(path, ROUNDS)
    }

    /// Rounds are a parameter so a test suite does not spend a second per login, and so
    /// the cost can be raised later without rewriting stored accounts — each account
    /// records the rounds it was hashed with.
    pub fn open_with_rounds(path: Option<PathBuf>, rounds: u32) -> UserStore {
        let accounts = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<Account>>(&s).ok())
            .unwrap_or_default();
        UserStore { path, rounds, accounts: RwLock::new(accounts) }
    }

    /// True when nobody has been created yet, which is what puts the installed build
    /// into its first-run "create the first admin" screen.
    pub fn is_empty(&self) -> bool {
        self.accounts.read().is_empty()
    }

    pub fn list(&self) -> Vec<Account> {
        self.accounts.read().clone()
    }

    /// True while the shipped account still has the shipped password.
    pub fn default_unchanged(&self) -> bool {
        self.accounts.read().iter().any(|a| a.name == DEFAULT_USER && a.must_change)
    }

    pub fn count_admins(&self) -> usize {
        self.accounts.read().iter().filter(|a| a.role == Role::Admin && !a.disabled).count()
    }

    fn save(&self) -> Result<(), AuthError> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_string_pretty(&*self.accounts.read())
            .map_err(|e| AuthError::Io(e.to_string()))?;
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Written beside the target and renamed: a crash mid-write must not leave an
        // accounts file that locks everybody out.
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, &body).map_err(|e| AuthError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, p).map_err(|e| AuthError::Io(e.to_string()))?;
        Ok(())
    }

    pub fn add(&self, name: &str, password: &str, role: Role) -> Result<(), AuthError> {
        self.add_inner(name, password, role, false, true)
    }

    fn add_inner(&self, name: &str, password: &str, role: Role, must_change: bool, enforce_len: bool)
        -> Result<(), AuthError>
    {
        let name = name.trim();
        if name.is_empty() {
            return Err(AuthError::Weak("the account needs a name".into()));
        }
        if enforce_len {
            check_password(password)?;
        }
        {
            let mut list = self.accounts.write();
            if list.iter().any(|a| a.name.eq_ignore_ascii_case(name)) {
                return Err(AuthError::Exists(name.to_string()));
            }
            let salt = random_hex(16);
            let hash = derive(password, &salt, self.rounds);
            list.push(Account {
                name: name.to_string(),
                role,
                salt,
                hash,
                rounds: self.rounds,
                created_at: now(),
                disabled: false,
                must_change,
                source: None,
                scope: None,
            });
        }
        self.save()
    }

    /// Create or refresh an account that another system vouches for.
    ///
    /// Zabbix is the authority for these: every sign-in rewrites the role and the scope
    /// from what Zabbix says now, so moving someone between Zabbix groups or roles takes
    /// effect at their next sign-in without anybody touching this app.
    ///
    /// Two refusals, both deliberate:
    ///
    /// * A local account with the same name is never taken over. The external name is
    ///   namespaced by the caller (`alice@zabbix`), so this only fires if somebody made a
    ///   local account with that exact name — and then it is theirs, not Zabbix's.
    /// * An account an admin disabled here stays disabled. Zabbix decides the role; this
    ///   app still decides whether you get in at all.
    ///
    /// The password is random and never shown. `verify` refuses external accounts
    /// outright, so it is not a second way in even in principle.
    pub fn upsert_external(&self, name: &str, source: &str, role: Role, scope: Option<Vec<String>>)
        -> Result<Account, AuthError>
    {
        let name = name.trim();
        if name.is_empty() {
            return Err(AuthError::Weak("the account needs a name".into()));
        }
        let out = {
            let mut list = self.accounts.write();
            match list.iter_mut().find(|a| a.name.eq_ignore_ascii_case(name)) {
                Some(a) => {
                    if a.source.as_deref() != Some(source) {
                        return Err(AuthError::Exists(name.to_string()));
                    }
                    if a.disabled {
                        return Err(AuthError::BadCredentials);
                    }
                    if a.role == role && a.scope == scope {
                        return Ok(a.clone());
                    }
                    a.role = role;
                    a.scope = scope;
                    a.clone()
                }
                None => {
                    let salt = random_hex(16);
                    // A password nobody knows, hashed cheaply: it is never checked.
                    let hash = derive(&random_hex(32), &salt, 1);
                    let a = Account {
                        name: name.to_string(),
                        role,
                        salt,
                        hash,
                        rounds: 1,
                        created_at: now(),
                        disabled: false,
                        must_change: false,
                        source: Some(source.to_string()),
                        scope,
                    };
                    list.push(a.clone());
                    a
                }
            }
        };
        self.save()?;
        Ok(out)
    }

    pub fn remove(&self, name: &str) -> Result<(), AuthError> {
        {
            let mut list = self.accounts.write();
            let Some(i) = list.iter().position(|a| a.name.eq_ignore_ascii_case(name)) else {
                return Err(AuthError::NotFound(name.to_string()));
            };
            let admins = list.iter().filter(|a| a.role == Role::Admin && !a.disabled).count();
            if list[i].role == Role::Admin && !list[i].disabled && admins <= 1 {
                return Err(AuthError::LastAdmin);
            }
            list.remove(i);
        }
        self.save()
    }

    pub fn set_role(&self, name: &str, role: Role) -> Result<(), AuthError> {
        {
            let mut list = self.accounts.write();
            let admins = list.iter().filter(|a| a.role == Role::Admin && !a.disabled).count();
            let Some(a) = list.iter_mut().find(|a| a.name.eq_ignore_ascii_case(name)) else {
                return Err(AuthError::NotFound(name.to_string()));
            };
            if a.role == Role::Admin && role != Role::Admin && admins <= 1 {
                return Err(AuthError::LastAdmin);
            }
            a.role = role;
        }
        self.save()
    }

    pub fn set_disabled(&self, name: &str, disabled: bool) -> Result<(), AuthError> {
        {
            let mut list = self.accounts.write();
            let admins = list.iter().filter(|a| a.role == Role::Admin && !a.disabled).count();
            let Some(a) = list.iter_mut().find(|a| a.name.eq_ignore_ascii_case(name)) else {
                return Err(AuthError::NotFound(name.to_string()));
            };
            if a.role == Role::Admin && disabled && admins <= 1 {
                return Err(AuthError::LastAdmin);
            }
            a.disabled = disabled;
        }
        self.save()
    }

    pub fn set_password(&self, name: &str, password: &str) -> Result<(), AuthError> {
        check_password(password)?;
        {
            let mut list = self.accounts.write();
            let Some(a) = list.iter_mut().find(|a| a.name.eq_ignore_ascii_case(name)) else {
                return Err(AuthError::NotFound(name.to_string()));
            };
            if let Some(src) = &a.source {
                return Err(AuthError::Weak(format!(
                    "{} signs in through {src}; its password is set there, not here", a.name
                )));
            }
            a.salt = random_hex(16);
            a.rounds = self.rounds;
            a.hash = derive(password, &a.salt, a.rounds);
            // The forced change is over the moment it happens.
            a.must_change = false;
        }
        self.save()
    }

    /// The account this name and password belong to, if any.
    pub fn verify(&self, name: &str, password: &str) -> Result<Account, AuthError> {
        let list = self.accounts.read();
        let found = list.iter().find(|a| a.name.eq_ignore_ascii_case(name.trim()));
        match found {
            // The hash is still computed for a name that does not exist, so the time
            // taken does not tell an attacker which names are real.
            None => {
                let _ = derive(password, &random_hex(16), self.rounds);
                Err(AuthError::BadCredentials)
            }
            Some(a) => {
                let got = derive(password, &a.salt, a.rounds);
                // An account another system vouches for has no password here, so no
                // password opens it — whatever was typed.
                if a.disabled || a.source.is_some() || !ct_eq(got.as_bytes(), a.hash.as_bytes()) {
                    Err(AuthError::BadCredentials)
                } else {
                    Ok(a.clone())
                }
            }
        }
    }
}

/* ---------------------------------- sessions ---------------------------------- */

#[derive(Clone, Debug)]
pub struct Session {
    pub user: String,
    pub role: Role,
    pub started: u64,
    pub must_change: bool,
    pub scope: Option<Vec<String>>,
}

/// Live sessions, in memory only.
///
/// Never persisted, for the same reason the write unlock is not: closing the app must
/// end the session, and a token found in a file after the fact must be worth nothing.
pub struct Sessions {
    map: RwLock<HashMap<String, (Session, Instant)>>,
    idle: Duration,
}

impl Default for Sessions {
    fn default() -> Self {
        Sessions::new(IDLE_TIMEOUT)
    }
}

impl Sessions {
    pub fn new(idle: Duration) -> Sessions {
        Sessions { map: RwLock::new(HashMap::new()), idle }
    }

    pub fn begin(&self, account: &Account) -> String {
        let token = random_hex(32);
        let s = Session {
            user: account.name.clone(),
            role: account.role,
            started: now(),
            must_change: account.must_change,
            scope: account.scope.clone(),
        };
        self.map.write().insert(token.clone(), (s, Instant::now()));
        token
    }

    /// The session this token names, if it is still live. Touches it, so an active
    /// session does not time out under someone.
    pub fn resolve(&self, token: &str) -> Option<Session> {
        let mut map = self.map.write();
        let idle = self.idle;
        map.retain(|_, (_, seen)| seen.elapsed() < idle);
        let (s, seen) = map.get_mut(token)?;
        *seen = Instant::now();
        Some(s.clone())
    }

    /// The session this token names, without touching it. For the event stream's
    /// periodic re-check: an open tab left alone must still time out, and resolving would
    /// keep its session alive for as long as the stream stays open.
    pub fn peek(&self, token: &str) -> Option<Session> {
        let map = self.map.read();
        let (s, seen) = map.get(token)?;
        (seen.elapsed() < self.idle).then(|| s.clone())
    }

    pub fn end(&self, token: &str) {
        self.map.write().remove(token);
    }

    /// The forced change is over for any session this account already holds.
    ///
    /// Needed because a session caches the flag it was created with: without this the
    /// operator changes their password, the account is updated, and the session they are
    /// sitting in is still locked to the change-password screen.
    pub fn clear_must_change(&self, user: &str) {
        for (s, _) in self.map.write().values_mut() {
            if s.user.eq_ignore_ascii_case(user) {
                s.must_change = false;
            }
        }
    }

    /// Rewrite the role and scope of every live session for one account. Used when Zabbix
    /// has just said something new about them: the change applies to the tab they already
    /// have open, not only to the next one.
    pub fn refresh_for(&self, user: &str, role: Role, scope: Option<Vec<String>>) {
        for (s, _) in self.map.write().values_mut() {
            if s.user.eq_ignore_ascii_case(user) {
                s.role = role;
                s.scope = scope.clone();
            }
        }
    }

    /// Every session for one account, gone. Used when an account is removed, disabled or
    /// demoted — otherwise the change does not take effect until they happen to log out.
    pub fn end_all_for(&self, user: &str) {
        self.map.write().retain(|_, (s, _)| !s.user.eq_ignore_ascii_case(user));
    }

    pub fn count(&self) -> usize {
        let idle = self.idle;
        let mut map = self.map.write();
        map.retain(|_, (_, seen)| seen.elapsed() < idle);
        map.len()
    }
}

/* --------------------------------- api tokens --------------------------------- */

/// A token for something that is not a person: Zabbix polling the automation state, or a
/// script. Hosted only — the desktop app has no socket to offer.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiToken {
    pub id: String,
    pub name: String,
    pub role: Role,
    /// SHA-256 of the secret, hex. The secret itself is shown once and never stored.
    hash: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_used: Option<u64>,
    #[serde(default)]
    pub expires_at: Option<u64>,
}

impl ApiToken {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "role": self.role.as_str(),
            "createdAt": self.created_at,
            "lastUsed": self.last_used,
            "expiresAt": self.expires_at,
        })
    }
    pub fn expired(&self) -> bool {
        self.expires_at.is_some_and(|e| now() >= e)
    }
}

/// The prefix makes a leaked token recognisable in a log or a paste, so it can be
/// revoked without anyone having to work out what it is.
pub const TOKEN_PREFIX: &str = "elasticpro_";

fn token_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

pub struct TokenStore {
    path: Option<PathBuf>,
    tokens: RwLock<Vec<ApiToken>>,
}

impl TokenStore {
    pub fn open(path: Option<PathBuf>) -> TokenStore {
        let tokens = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<ApiToken>>(&s).ok())
            .unwrap_or_default();
        TokenStore { path, tokens: RwLock::new(tokens) }
    }

    fn save(&self) -> Result<(), AuthError> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_string_pretty(&*self.tokens.read())
            .map_err(|e| AuthError::Io(e.to_string()))?;
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, &body).map_err(|e| AuthError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, p).map_err(|e| AuthError::Io(e.to_string()))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<ApiToken> {
        self.tokens.read().clone()
    }

    /// Returns the secret. It is not stored and cannot be shown again.
    pub fn create(&self, name: &str, role: Role, ttl_days: Option<u32>) -> Result<String, AuthError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AuthError::Weak("the token needs a name, so it can be recognised later".into()));
        }
        let secret = format!("{TOKEN_PREFIX}{}", random_hex(32));
        let t = ApiToken {
            id: random_hex(8),
            name: name.to_string(),
            role,
            hash: token_hash(&secret),
            created_at: now(),
            last_used: None,
            expires_at: ttl_days.map(|d| now() + u64::from(d) * 86400),
        };
        self.tokens.write().push(t);
        self.save()?;
        Ok(secret)
    }

    pub fn revoke(&self, id: &str) -> Result<(), AuthError> {
        {
            let mut list = self.tokens.write();
            let Some(i) = list.iter().position(|t| t.id == id) else {
                return Err(AuthError::NotFound(id.to_string()));
            };
            list.remove(i);
        }
        self.save()
    }

    /// The role this secret carries, if it is a live token. Records the use.
    pub fn verify(&self, secret: &str) -> Option<Role> {
        let want = token_hash(secret);
        let mut list = self.tokens.write();
        let t = list.iter_mut().find(|t| ct_eq(t.hash.as_bytes(), want.as_bytes()))?;
        if t.expired() {
            return None;
        }
        t.last_used = Some(now());
        let role = t.role;
        drop(list);
        let _ = self.save();
        Some(role)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> UserStore {
        // 1 round: these tests are about the logic, not the cost of the KDF.
        UserStore::open_with_rounds(None, 1)
    }

    #[test]
    fn portable_has_no_accounts_and_no_tokens() {
        assert!(!Edition::Portable.uses_accounts());
        assert!(!Edition::Portable.uses_api_tokens());
        assert!(Edition::Installed.uses_accounts());
        assert!(
            !Edition::Installed.uses_api_tokens(),
            "the desktop app has no socket to serve an API on"
        );
        assert!(Edition::Hosted.uses_accounts() && Edition::Hosted.uses_api_tokens());
        // Only a daemon schedules. A portable copy carried to another machine must not
        // start measuring clusters on its own.
        assert!(Edition::Hosted.schedules());
        assert!(!Edition::Portable.schedules() && !Edition::Installed.schedules());
    }

    #[test]
    fn a_password_round_trips_and_a_wrong_one_does_not() {
        let s = store();
        s.add("alice", "correct-horse", Role::Admin).unwrap();
        assert_eq!(s.verify("alice", "correct-horse").unwrap().role, Role::Admin);
        assert_eq!(s.verify("alice", "wrong").unwrap_err(), AuthError::BadCredentials);
        // A name that does not exist fails the same way, saying nothing about who exists.
        assert_eq!(s.verify("mallory", "anything").unwrap_err(), AuthError::BadCredentials);
    }

    #[test]
    fn names_are_case_insensitive_but_a_duplicate_is_refused() {
        let s = store();
        s.add("Alice", "correct-horse", Role::User).unwrap();
        assert!(s.verify("alice", "correct-horse").is_ok());
        assert_eq!(s.add("ALICE", "another-one-x", Role::User).unwrap_err(), AuthError::Exists("ALICE".into()));
    }

    #[test]
    fn a_short_password_is_refused() {
        let s = store();
        assert!(matches!(s.add("bob", "short", Role::User), Err(AuthError::Weak(_))));
    }

    #[test]
    fn a_disabled_account_cannot_log_in() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.add("bob", "correct-horse", Role::User).unwrap();
        s.set_disabled("bob", true).unwrap();
        assert_eq!(s.verify("bob", "correct-horse").unwrap_err(), AuthError::BadCredentials);
    }

    #[test]
    fn the_last_admin_cannot_be_removed_demoted_or_disabled() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.add("bob", "correct-horse", Role::User).unwrap();
        assert_eq!(s.remove("root").unwrap_err(), AuthError::LastAdmin);
        assert_eq!(s.set_role("root", Role::User).unwrap_err(), AuthError::LastAdmin);
        assert_eq!(s.set_disabled("root", true).unwrap_err(), AuthError::LastAdmin);
        // With a second admin, the first is no longer load-bearing.
        s.set_role("bob", Role::Admin).unwrap();
        assert!(s.remove("root").is_ok());
    }

    #[test]
    fn a_changed_password_invalidates_the_old_one() {
        let s = store();
        s.add("alice", "correct-horse", Role::User).unwrap();
        s.set_password("alice", "battery-staple").unwrap();
        assert_eq!(s.verify("alice", "correct-horse").unwrap_err(), AuthError::BadCredentials);
        assert!(s.verify("alice", "battery-staple").is_ok());
    }

    #[test]
    fn accounts_survive_a_reopen_and_the_hash_is_not_the_password() {
        let dir = std::env::temp_dir().join(format!("elasticpro-auth-{}", random_hex(8)));
        let path = dir.join("users.json");
        {
            let s = UserStore::open_with_rounds(Some(path.clone()), 1);
            s.add("alice", "correct-horse", Role::Admin).unwrap();
        }
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("correct-horse"), "the password must not be in the file: {raw}");
        let s2 = UserStore::open_with_rounds(Some(path.clone()), 1);
        assert_eq!(s2.verify("alice", "correct-horse").unwrap().role, Role::Admin);
        assert!(!s2.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ------------------------------ the first account ----------------------------- */

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("elasticpro-seed-{}", random_hex(8)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn each_install_gets_its_own_first_password() {
        let (a, b) = (store(), store());
        let pa = seed_first_account(&a, None, None).unwrap().generated.unwrap();
        let pb = seed_first_account(&b, None, None).unwrap().generated.unwrap();
        assert_ne!(pa, pb, "two installs must not share a first password");
        for p in [&pa, &pb] {
            assert_eq!(p.chars().count(), INITIAL_LEN);
            assert!(p.bytes().all(|c| INITIAL_ALPHABET.contains(&c)), "outside the alphabet: {p}");
        }
        let acct = a.verify(DEFAULT_USER, &pa).unwrap();
        assert!(acct.must_change && acct.role == Role::Admin);
        assert_eq!(a.verify(DEFAULT_USER, "loginme").unwrap_err(), AuthError::BadCredentials);
        // Only ever the first account: a store with accounts is left alone.
        assert!(seed_first_account(&a, None, None).is_none());
        assert_eq!(a.list().len(), 1);
    }

    #[test]
    fn the_first_password_is_written_owner_only_and_retired_after_the_change() {
        let dir = scratch();
        let file = dir.join(INITIAL_PASSWORD_FILE);
        let s = UserStore::open_with_rounds(Some(dir.join("users.json")), 1);
        let seeded = seed_first_account(&s, Some(&file), None).unwrap();
        let pw = seeded.generated.unwrap();
        assert_eq!(seeded.written_to.as_deref(), Some(file.as_path()));
        assert_eq!(std::fs::read_to_string(&file).unwrap().trim_end(), pw);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "mode {mode:o}");
        }
        assert!(!dir.join("initial-admin-password.tmp").exists());
        // Still the live password: the file stays.
        assert!(!retire_initial_password_file(&s, Some(&file)));
        assert!(file.exists());
        s.set_password(DEFAULT_USER, "a-real-password-now").unwrap();
        assert!(retire_initial_password_file(&s, Some(&file)));
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_operator_file_sets_the_first_password_and_is_not_copied() {
        let dir = scratch();
        let over = dir.join("pw");
        std::fs::write(&over, "operator-chosen-pass\n").unwrap();
        let file = dir.join(INITIAL_PASSWORD_FILE);
        let s = store();
        let seeded = seed_first_account(&s, Some(&file), Some(&over)).unwrap();
        assert!(seeded.generated.is_none() && seeded.override_error.is_none());
        assert!(!file.exists(), "the operator already has it; no second copy");
        assert!(s.verify(DEFAULT_USER, "operator-chosen-pass").unwrap().must_change);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_short_operator_file_is_refused_and_a_random_password_used_instead() {
        let dir = scratch();
        let over = dir.join("pw");
        std::fs::write(&over, "short\n").unwrap();
        assert!(matches!(read_initial_password_file(&over), Err(AuthError::Weak(_))));
        let s = store();
        let seeded = seed_first_account(&s, None, Some(&over)).unwrap();
        assert!(seeded.override_error.as_deref().unwrap().contains("at least"));
        let pw = seeded.generated.expect("never an empty store");
        assert!(s.verify(DEFAULT_USER, "short").is_err());
        assert!(s.verify(DEFAULT_USER, &pw).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_accounts_with_one_password_get_different_hashes() {
        let dir = std::env::temp_dir().join(format!("elasticpro-auth-{}", random_hex(8)));
        let path = dir.join("users.json");
        let s = UserStore::open_with_rounds(Some(path.clone()), 1);
        s.add("a", "correct-horse", Role::User).unwrap();
        s.add("b", "correct-horse", Role::User).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_ne!(v[0]["hash"], v[1]["hash"], "per-account salt must make these differ");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ------------------------------- authorisation ------------------------------- */

    #[test]
    fn only_admin_writes_to_a_cluster() {
        assert!(authorize(Role::Admin, "ES", "DELETE", "/logstash-2026.01.01").is_ok());
        assert!(authorize(Role::User, "ES", "DELETE", "/logstash-2026.01.01").is_err());
        assert!(authorize(Role::Guest, "ES", "DELETE", "/logstash-2026.01.01").is_err());
        assert!(authorize(Role::User, "ES", "PUT", "/idx").is_err());
        // A read is fine for a user.
        assert!(authorize(Role::User, "ES", "GET", "/_cat/indices").is_ok());
    }

    #[test]
    fn a_user_is_read_only_everywhere_that_matters() {
        for t in ["WRITE_UNLOCK", "CONFIG_READ", "CONFIG_WRITE", "VAULT_GET", "TRUST_CERT", "PRIME", "USER_ADD", "TOKEN_CREATE"] {
            assert!(authorize(Role::User, t, "", "").is_err(), "{t} must not be open to a user");
            assert!(authorize(Role::Admin, t, "", "").is_ok(), "{t} must be open to an admin");
        }
    }

    #[test]
    fn a_guest_sees_health_and_nothing_that_names_an_index() {
        for p in ["/_cluster/health", "/_cat/nodes?h=name", "/_nodes/stats/fs", "/", "/_cat/allocation"] {
            assert!(authorize(Role::Guest, "ES", "GET", p).is_ok(), "guest should see {p}");
        }
        for p in ["/_cat/indices", "/logstash-*/_search", "/_snapshot/repo/_all", "/_ilm/explain", "/_cat/nodesomething"] {
            assert!(authorize(Role::Guest, "ES", "GET", p).is_err(), "guest must not see {p}");
        }
        // and not the pages that name hosts
        assert!(authorize(Role::Guest, "TUNNELS", "", "").is_err());
        assert!(authorize(Role::Guest, "PINS", "", "").is_err());
    }

    #[test]
    fn a_guest_cannot_walk_out_of_the_allowlist() {
        assert!(authorize(Role::Guest, "ES", "GET", "/_cluster/health/../../_cat/indices").is_err());
        assert!(authorize(Role::Guest, "ES", "GET", "/_nodes/../_cat/indices").is_err());
    }

    #[test]
    fn ping_answers_before_anyone_has_logged_in() {
        assert_eq!(required_role("PING"), None);
        assert_eq!(required_role("LOGIN"), None);
        assert!(authorize(Role::Guest, "PING", "", "").is_ok());
    }

    #[test]
    fn an_unknown_message_is_refused_rather_than_waved_through() {
        assert_eq!(required_role("SOMETHING_NEW"), Some(Role::Admin));
        assert!(authorize(Role::User, "SOMETHING_NEW", "", "").is_err());
    }

    #[test]
    fn the_old_schema_role_names_still_resolve() {
        assert_eq!(Role::parse("viewer"), Some(Role::User));
        // It meant admin while it was a name in a plan. It is its own role now, and the
        // change only ever narrows: nothing that was stored could have held it, because
        // the enum had no such variant to serialise.
        assert_eq!(Role::parse("operator"), Some(Role::Operator));
        assert_eq!(Role::parse("ADMIN"), Some(Role::Admin));
        assert_eq!(Role::parse("nonsense"), None);
    }

    /* --------------------------------- sessions --------------------------------- */

    #[test]
    fn a_session_resolves_until_it_is_ended() {
        let s = store();
        s.add("alice", "correct-horse", Role::User).unwrap();
        let acct = s.verify("alice", "correct-horse").unwrap();
        let ss = Sessions::default();
        let tok = ss.begin(&acct);
        assert_eq!(ss.resolve(&tok).unwrap().role, Role::User);
        ss.end(&tok);
        assert!(ss.resolve(&tok).is_none());
        assert!(ss.resolve("not-a-token").is_none());
    }

    #[test]
    fn an_idle_session_expires() {
        let s = store();
        s.add("alice", "correct-horse", Role::User).unwrap();
        let acct = s.verify("alice", "correct-horse").unwrap();
        let ss = Sessions::new(Duration::from_millis(30));
        let tok = ss.begin(&acct);
        assert!(ss.resolve(&tok).is_some());
        std::thread::sleep(Duration::from_millis(60));
        assert!(ss.resolve(&tok).is_none(), "an idle session must not live forever");
    }

    #[test]
    fn demoting_someone_can_end_their_session() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.add("bob", "correct-horse", Role::Admin).unwrap();
        let acct = s.verify("bob", "correct-horse").unwrap();
        let ss = Sessions::default();
        let tok = ss.begin(&acct);
        s.set_role("bob", Role::Guest).unwrap();
        ss.end_all_for("bob");
        assert!(ss.resolve(&tok).is_none(), "a demotion must not wait for a logout");
    }

    /* -------------------------------- api tokens -------------------------------- */

    #[test]
    fn a_token_verifies_once_created_and_not_after_revoking() {
        let ts = TokenStore::open(None);
        let secret = ts.create("zabbix", Role::User, None).unwrap();
        assert!(secret.starts_with(TOKEN_PREFIX), "a leaked token should be recognisable: {secret}");
        assert_eq!(ts.verify(&secret), Some(Role::User));
        let id = ts.list()[0].id.clone();
        ts.revoke(&id).unwrap();
        assert_eq!(ts.verify(&secret), None);
    }

    #[test]
    fn the_secret_is_never_stored() {
        let dir = std::env::temp_dir().join(format!("elasticpro-tok-{}", random_hex(8)));
        let path = dir.join("tokens.json");
        let ts = TokenStore::open(Some(path.clone()));
        let secret = ts.create("zabbix", Role::Guest, None).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&secret), "the token secret must not be on disk");
        assert!(TokenStore::open(Some(path.clone())).verify(&secret) == Some(Role::Guest));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_token_stops_working() {
        let ts = TokenStore::open(None);
        let secret = ts.create("short-lived", Role::User, Some(0)).unwrap();
        // ttl of 0 days: expires_at == now, and expiry is >=, so it is already past.
        assert_eq!(ts.verify(&secret), None);
    }

    #[test]
    fn a_token_carries_a_role_like_anyone_else() {
        let ts = TokenStore::open(None);
        let guest = ts.create("dashboard", Role::Guest, None).unwrap();
        let role = ts.verify(&guest).unwrap();
        assert!(authorize(role, "ES", "GET", "/_cluster/health").is_ok());
        assert!(authorize(role, "ES", "GET", "/_cat/indices").is_err());
        assert!(authorize(role, "ES", "DELETE", "/idx").is_err());
    }
}
