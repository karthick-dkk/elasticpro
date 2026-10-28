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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};

/// Matches `crypto.rs`. Login is not a hot path; the cost is the point.
pub const ROUNDS: u32 = 600_000;


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
    /// Only an admin writes to a cluster. An operator (a Zabbix Admin) administers alerts
    /// and silences but sends nothing but reads to Elasticsearch: GET, HEAD and the
    /// search-family POSTs (`guard::is_read`).
    pub fn may_write(self) -> bool {
        matches!(self, Role::Admin)
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
        // The request policy: how and whether the poller goes to the clusters. Reading it is
        // how a page says "paused"; changing it changes the load on every cluster.
        "POLICY_GET" => Some(Role::User),
        // Letting go of one's own in-flight page requests. Keyed by the caller, so it reaches
        // nobody else's; it sends nothing to a cluster.
        "ABORT_REQUESTS" => Some(Role::User),
        "POLICY_SET" => Some(Role::Admin),

        // Fleet facts with no index names, but they name hosts and jump hosts.
        "TUNNELS" | "PINS" | "REQUEST_STATS" => Some(Role::User),
        // Every request on the clusters the caller may see, whoever asked: an administrator's view.
        "REQUEST_LOG" => Some(Role::Admin),
        // Listing the archive names object keys, which carry client and branch names —
        // the same shape of fact as an index name, and gated the same way.

        // Everything below either writes, or hands back something secret.
        // CONFIG_READ returns the raw config, which carries cluster credentials.
        "CONFIG_READ" | "CONFIG_WRITE" | "FILE_WRITE" => Some(Role::Admin),
        // One cluster added, changed or switched off in the config file — and nothing
        // else: no removal, no credential, nothing outside clusters[] (cluster_save.rs
        // holds the rule). An operator runs the fleet day to day; this is the part of the
        // config that is day-to-day work. The file itself stays an admin's to read.
        "CLUSTER_SAVE" => Some(Role::Operator),
        // The automations list, likewise: rules an operator writes that propose what an
        // admin then runs. Plain data, bounded, no credential (cluster_save.rs).
        "AUTOMATIONS_SAVE" => Some(Role::Operator),
        // Which Zabbix role becomes which ElasticPro role at sign-in: who gets in, and as
        // what. An administrator's, like the accounts themselves.
        "ZABBIX_ROLEMAP_GET" | "ZABBIX_ROLEMAP_SET" => Some(Role::Admin),
        // The credentials the hosted server keeps for its clusters (cluster_secrets): an admin's.
        "CREDENTIAL_STATUS" | "CREDENTIAL_SET" | "CREDENTIAL_CLEAR" => Some(Role::Admin),
        "PRIME" | "FORGET" => Some(Role::Admin),
        // Operators write to clusters, so they unlock the guard to do it. The guard is
        // still one switch for the whole process, and still resets on restart.
        // Writing to a cluster is an admin's alone, so is unlocking the guard to do it.
        "WRITE_UNLOCK" => Some(Role::Admin),
        "SEAL" | "OPEN" => Some(Role::Admin),
        "VAULT_GET" | "VAULT_SET" | "VAULT_DEL" => Some(Role::Admin),
        "TRUST_CERT" | "UNTRUST_CERT" | "TRUST_HOSTKEY" | "UNTRUST_HOSTKEY" => Some(Role::Admin),
        "TUNNEL_SECRET" | "TUNNEL_RECONNECT" => Some(Role::Admin),
        "USER_LIST" | "USER_ADD" | "USER_REMOVE" | "USER_SET_ROLE" | "USER_SET_PASSWORD" => Some(Role::Admin),
        // Handing a Zabbix account's role back to Zabbix is changing its role.
        "USER_UNPIN_ROLE" => Some(Role::Admin),
        // Locking, blocking and the sign-in log: who may get in is an administrator's call.
        "USER_SET_LOCKED" | "USER_SET_BLOCKED" | "USER_LOGINS" => Some(Role::Admin),
        // Everyone's activity, with source addresses: an administrator's to read.
        "ACTIVITY_LIST" => Some(Role::Admin),
        // Uploading a private key, and every version of a config that has held
        // credentials. Nothing below admin goes near either.
        "KEY_UPLOAD" | "KEY_LIST" | "KEY_DELETE" => Some(Role::Admin),
        "CONFIG_HISTORY" | "CONFIG_RESTORE" => Some(Role::Admin),
        "TOKEN_LIST" | "TOKEN_CREATE" | "TOKEN_REVOKE" => Some(Role::Admin),
        // Arming the scheduled measurement decides that this process will write
        // to a cluster unattended. Nothing below admin goes near it.
        "DELAY_SINK_GET" | "DELAY_SINK_SET" | "DELAY_SINK_RUN" => Some(Role::Admin),
        // Housekeeping deletes files, sessions and cache entries: an administrator's to read
        // the state of and to run.
        "HOUSEKEEPING_GET" | "HOUSEKEEPING_RUN" => Some(Role::Admin),

        // The caller's own notification history. Not a write to any cluster, so no write
        // unlock; anybody signed in, and the handler only ever uses the caller's own name.
        "NOTIFY_PUT" | "NOTIFY_LIST" | "NOTIFY_CLEAR" => Some(Role::Guest),
        // Silences: everyone who sees alerts may see why some are quiet; setting or removing
        // one changes what the whole team is shown, so an operator's (it is audited).
        "SILENCE_LIST" => Some(Role::User),
        // Saved console queries: the console is a user's page; each person manages their own
        // (the handler checks ownership), and sees what others chose to share.
        "QUERY_LIST" | "QUERY_SAVE" | "QUERY_DELETE" => Some(Role::User),
        "SILENCE_SET" | "SILENCE_CLEAR" => Some(Role::Operator),

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
    // A search sent as POST is still a read: the same list the write guard uses.
    let is_read = m.is_empty() || crate::guard::is_read(&m, path);
    if !is_read && !role.may_write() {
        return Err(format!(
            "{m} {} is not available to the {} role — only an ElasticPro admin can change a cluster; reads (GET and searches) are allowed",
            path.split('?').next().unwrap_or(path),
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
    /// scope is rewritten from Zabbix every time that person signs in, and so is its role
    /// unless an admin pinned it here (`role_pinned`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// An admin set this external account's role on the Accounts page, so a sign-in from
    /// its source no longer rewrites it. Only ever set on an account with a `source`; a
    /// local account's role is always the one set here anyway. `USER_UNPIN_ROLE` clears it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub role_pinned: bool,
    /// Zabbix user groups this account is limited to; `None` sees every cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<String>>,
    /// Locked by an admin: no new sign-in until an admin unlocks it. Sessions already open
    /// carry on — blocking (`disabled`) is what stops those.
    #[serde(default)]
    pub locked: bool,
    /// Locked by itself after `LOCK_AFTER` wrong passwords in a row, until this time.
    ///
    /// This and the two below are kept in memory only, never written to the accounts file:
    /// a wrong password must cost the same as a name that does not exist, and a disk write
    /// on one and not the other would tell an attacker which names are real. A restart
    /// clears a self-lock, which an admin can do anyway.
    #[serde(skip)]
    pub locked_until: Option<u64>,
    /// Wrong passwords since the last good one.
    #[serde(skip)]
    pub failed_logins: u32,
    #[serde(skip)]
    pub last_failed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_login: Option<u64>,
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
            "rolePinned": self.role_pinned,
            "scope": self.scope,
            "locked": self.locked,
            "lockedUntil": self.locked_until.filter(|t| *t > now()),
            "failedLogins": self.failed_logins,
            "lastLogin": self.last_login,
            "lastFailed": self.last_failed,
        })
    }

    /// Locked now, by an admin or by itself.
    pub fn is_locked(&self, at: u64) -> bool {
        self.locked || self.locked_until.is_some_and(|t| t > at)
    }
}

/// Wrong passwords in a row that lock an account by itself, and for how long.
pub const LOCK_AFTER: u32 = 5;
pub const LOCK_SECS: u64 = 15 * 60;
/// The last admin is never locked out by wrong passwords — that would let anyone who knows
/// the name shut a whole installation out of its administration. Past `LOCK_AFTER` it is
/// slowed instead: one password checked per this many seconds, so guessing stays hopeless
/// (two tries a minute against a password of at least ten characters).
pub const ADMIN_THROTTLE_SECS: u64 = 30;
/// Sign-in attempts kept for the Accounts page, newest last.
pub const LOGIN_LOG_LEN: usize = 300;

/// One sign-in attempt, as the Accounts page lists it. Never the password.
#[derive(Clone, Debug, Serialize)]
pub struct LoginEvent {
    pub at: u64,
    /// The name as typed (trimmed, at most 64 characters): a mistyped name is worth seeing.
    pub name: String,
    pub ok: bool,
    /// The kind of failure, which errors.rs turns into a code; empty on success.
    pub kind: String,
    pub code: String,
    /// "password" or "zabbix".
    pub via: String,
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
    /// A locked account, whatever password was typed.
    Locked,
    /// A blocked account, whatever password was typed.
    Blocked,
    /// The last admin after too many wrong passwords: wait this many seconds between tries.
    Throttled(u64),
}

impl AuthError {
    /// The bridge's `kind` for this refusal (errors.rs gives it its code).
    pub fn kind(&self) -> &'static str {
        match self {
            AuthError::BadCredentials => "bad_credentials",
            AuthError::Exists(_) => "name_taken",
            AuthError::NotFound(_) => "not_found",
            AuthError::LastAdmin => "forbidden",
            AuthError::Weak(_) => "bad_request",
            AuthError::Io(_) => "io_error",
            AuthError::Locked => "locked",
            AuthError::Blocked => "disabled",
            AuthError::Throttled(_) => "rate_limited",
        }
    }
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
            AuthError::Locked => write!(f, "this account is locked — an ElasticPro administrator can unlock it on the Accounts page"),
            AuthError::Blocked => write!(f, "this account is blocked — ask an ElasticPro administrator"),
            AuthError::Throttled(secs) => write!(f, "too many wrong passwords — wait {secs} seconds before the next try"),
        }
    }
}

/// The shortest password worth calling one. Long enough to matter, short enough that
/// nobody writes it on a sticky note.
pub const MIN_PASSWORD: usize = 10;

/// The account a fresh install starts with, and the password it opens with.
///
/// Both ship in the source, as Zabbix's own `Admin`/`zabbix` do: whoever installs the app
/// knows the way in without reading a log or a file inside a volume. The cost is the
/// obvious one — until the password is changed, anyone who reaches the sign-in page has
/// the account — so the core says so on every start it still opens, and the Accounts page
/// is where the administrator changes it, whenever they choose. It is not forced: an
/// account made `must_change` can do nothing but replace its password, and the point of a
/// known default is to be usable at once.
///
/// [`INITIAL_PASSWORD_ENV`] names a file to take the first password from instead, for an
/// install that must never open with the shipped one.
pub const DEFAULT_USER: &str = "Admin";
/// Shorter than [`MIN_PASSWORD`] on purpose: it is the one password the store accepts
/// without the check, because it is the one everybody is expected to replace. It can never
/// be *set* — `set_password` holds a new password to the minimum.
pub const DEFAULT_PASSWORD: &str = "elastic";

/// Names a file to take the first password from instead of the shipped one. A file and
/// never the password itself: an environment variable shows up in `docker inspect`,
/// `/proc/<pid>/environ` and every child process.
pub const INITIAL_PASSWORD_ENV: &str = "ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE";

/// The password in an operator's override file: its first line, line ending dropped,
/// held to the same minimum as any password change.
pub fn read_initial_password_file(path: &std::path::Path) -> Result<String, AuthError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AuthError::Io(format!("cannot read {}: {e}", path.display())))?;
    let pw = raw.lines().next().unwrap_or("").to_string();
    check_password(&pw)?;
    Ok(pw)
}

/// What [`seed_first_account`] did, for the caller to log.
#[derive(Debug)]
pub struct Seeded {
    /// The password came from the operator's [`INITIAL_PASSWORD_ENV`] file, not the source.
    pub from_override: bool,
    /// Why the operator's override file was not used (the shipped password was used instead).
    pub override_error: Option<String>,
    /// Why the accounts file could not be saved (the account exists for this run only).
    pub save_error: Option<String>,
}

/// Create the first account when there are none; `None` when accounts already exist.
///
/// `override_file`: the operator's [`INITIAL_PASSWORD_ENV`] file, if set. One that cannot
/// be used falls back to the shipped password rather than to no account at all: an empty
/// accounts store offers `BOOTSTRAP_ADMIN` to whoever asks first, which is the very race
/// this replaces.
pub fn seed_first_account(users: &UserStore, override_file: Option<&std::path::Path>) -> Option<Seeded> {
    if !users.is_empty() {
        return None;
    }
    let mut out = Seeded { from_override: false, override_error: None, save_error: None };
    let password = match override_file.map(read_initial_password_file) {
        Some(Ok(pw)) => {
            out.from_override = true;
            pw
        }
        Some(Err(e)) => {
            out.override_error = Some(e.to_string());
            DEFAULT_PASSWORD.to_string()
        }
        None => DEFAULT_PASSWORD.to_string(),
    };
    if let Err(e) = users.add_inner(DEFAULT_USER, &password, Role::Admin, false, false) {
        if users.is_empty() {
            return None;
        }
        out.save_error = Some(e.to_string());
    }
    Some(out)
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
    logins: parking_lot::Mutex<std::collections::VecDeque<LoginEvent>>,
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
        UserStore { path, rounds, accounts: RwLock::new(accounts), logins: Default::default() }
    }

    /// True when nobody has been created yet, which is what puts the installed build
    /// into its first-run "create the first admin" screen.
    pub fn is_empty(&self) -> bool {
        self.accounts.read().is_empty()
    }

    pub fn list(&self) -> Vec<Account> {
        self.accounts.read().clone()
    }

    /// True while the shipped account still opens with the shipped password — the state
    /// every start warns about. A real verification, so it costs one key derivation.
    pub fn default_unchanged(&self) -> bool {
        self.verify(DEFAULT_USER, DEFAULT_PASSWORD).is_ok()
    }

    /// An account that must change its password before it can do anything else. Only
    /// tests reach this: nothing an operator does creates one any more, and the fence
    /// (`must_change_password`) still has to be proven through the message API.
    #[doc(hidden)]
    pub fn add_must_change(&self, name: &str, password: &str, role: Role) -> Result<(), AuthError> {
        self.add_inner(name, password, role, true, true)
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
                role_pinned: false,
                scope: None,
                locked: false,
                locked_until: None,
                failed_logins: 0,
                last_login: None,
                last_failed: None,
            });
        }
        self.save()
    }

    /// Create or refresh an account that another system vouches for.
    ///
    /// Zabbix is the authority for the scope: every sign-in rewrites it from what Zabbix
    /// says now, so moving someone between Zabbix groups takes effect at their next sign-in
    /// without anybody touching this app. The role follows Zabbix the same way until an
    /// admin changes it here: `set_role` pins it, and from then on a sign-in keeps the
    /// pinned role (the decision of 2026-10-22: ElasticPro's role is the authority for who
    /// may edit Cluster Management, so it has to stick). `unpin_role` hands it back.
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
                        return Err(AuthError::Blocked);
                    }
                    if a.is_locked(now()) {
                        return Err(AuthError::Locked);
                    }
                    a.last_login = Some(now());
                    if !a.role_pinned {
                        a.role = role;
                    }
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
                        role_pinned: false,
                        scope,
                        locked: false,
                        locked_until: None,
                        failed_logins: 0,
                        last_login: Some(now()),
                        last_failed: None,
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
            // An admin chose this role for an account another system signs in: it sticks.
            if a.source.is_some() {
                a.role_pinned = true;
            }
        }
        self.save()
    }

    /// Let the account's source set its role again, from its next sign-in. The role stays
    /// what it is until then. Refused for a local account (nothing to follow) and, while
    /// this is the only working admin, for an admin: the next sign-in could demote it and
    /// leave nobody able to administer.
    pub fn unpin_role(&self, name: &str) -> Result<(), AuthError> {
        {
            let mut list = self.accounts.write();
            let admins = list.iter().filter(|a| a.role == Role::Admin && !a.disabled).count();
            let Some(a) = list.iter_mut().find(|a| a.name.eq_ignore_ascii_case(name)) else {
                return Err(AuthError::NotFound(name.to_string()));
            };
            if a.source.is_none() {
                return Err(AuthError::Weak(format!("{} is a local account: its role is set here and follows nothing else", a.name)));
            }
            if a.role == Role::Admin && !a.disabled && admins <= 1 {
                return Err(AuthError::LastAdmin);
            }
            if !a.role_pinned {
                return Ok(());
            }
            a.role_pinned = false;
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

    /// Lock (no new sign-in) or unlock. Unlocking also clears a lock the account put on
    /// itself and its count of wrong passwords.
    pub fn set_locked(&self, name: &str, locked: bool) -> Result<(), AuthError> {
        {
            let mut list = self.accounts.write();
            let admins = list.iter().filter(|a| a.role == Role::Admin && !a.disabled && !a.locked).count();
            let Some(a) = list.iter_mut().find(|a| a.name.eq_ignore_ascii_case(name)) else {
                return Err(AuthError::NotFound(name.to_string()));
            };
            if a.role == Role::Admin && locked && !a.locked && admins <= 1 {
                return Err(AuthError::LastAdmin);
            }
            a.locked = locked;
            if !locked {
                a.locked_until = None;
                a.failed_logins = 0;
            }
        }
        self.save()
    }

    /// Blocked accounts are refused everything, signed in or not.
    pub fn is_blocked(&self, name: &str) -> bool {
        self.accounts.read().iter().any(|a| a.name.eq_ignore_ascii_case(name) && a.disabled)
    }

    /// Note a sign-in attempt for the Accounts page.
    pub fn record_login(&self, name: &str, via: &str, result: Result<(), &AuthError>) {
        let (ok, kind) = match result {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e.kind().to_string()),
        };
        let code = if ok { String::new() } else { crate::errors::code_for(&kind).to_string() };
        let name: String = name.trim().chars().filter(|c| !c.is_control()).take(64).collect();
        let mut log = self.logins.lock();
        log.push_back(LoginEvent { at: now(), name, ok, kind, code, via: via.to_string() });
        while log.len() > LOGIN_LOG_LEN {
            log.pop_front();
        }
    }

    /// The sign-in attempts kept, newest first.
    pub fn logins(&self) -> Vec<LoginEvent> {
        self.logins.lock().iter().rev().cloned().collect()
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
    ///
    /// A wrong password counts against the account, and `LOCK_AFTER` of them in a row lock
    /// it for `LOCK_SECS`. The last admin who can still get in is slowed instead of locked
    /// (`ADMIN_THROTTLE_SECS`). While an account is locked or blocked, that is the answer
    /// whatever password was typed: answering "locked" only to the right password would
    /// tell an attacker which guess was right.
    ///
    /// The hash is worked out with no lock held: it is the slow part, on purpose, and every
    /// request reads this list (`is_blocked`). Only the bookkeeping after it takes the
    /// write lock, briefly, and it re-checks that the password it compared against is still
    /// the account's. A failure touches memory only, the same as a name that does not
    /// exist; only a good sign-in is written down.
    pub fn verify(&self, name: &str, password: &str) -> Result<Account, AuthError> {
        let found = self.accounts.read().iter()
            .find(|a| a.name.eq_ignore_ascii_case(name.trim()))
            .map(|a| (a.name.clone(), a.salt.clone(), a.rounds, a.hash.clone(), a.source.is_some()));
        // The hash is still computed for a name that does not exist, so the time taken does
        // not tell an attacker which names are real.
        let Some((real, salt, rounds, hash, external)) = found else {
            let _ = derive(password, &random_hex(16), self.rounds);
            return Err(AuthError::BadCredentials);
        };
        let got = derive(password, &salt, rounds);
        // An account another system vouches for has no password here, so no password opens
        // it — whatever was typed.
        if external {
            return Err(AuthError::BadCredentials);
        }
        let at = now();
        let out = {
            let mut list = self.accounts.write();
            let usable_admins = list.iter().filter(|a| a.role == Role::Admin && !a.disabled && !a.is_locked(at)).count();
            let Some(a) = list.iter_mut().find(|a| a.name == real) else {
                return Err(AuthError::BadCredentials);   // removed while we were hashing
            };
            // Changed while we were hashing: what was compared is no longer the password.
            if a.hash != hash || a.salt != salt {
                return Err(AuthError::BadCredentials);
            }
            if a.disabled {
                return Err(AuthError::Blocked);
            }
            if a.is_locked(at) {
                return Err(AuthError::Locked);
            }
            let last_admin = a.role == Role::Admin && usable_admins <= 1;
            // The last admin, past the threshold: one check per ADMIN_THROTTLE_SECS. Inside
            // the window nothing is compared — right or wrong, the answer is the same.
            if last_admin && a.failed_logins >= LOCK_AFTER
                && a.last_failed.is_some_and(|t| at < t + ADMIN_THROTTLE_SECS) {
                return Err(AuthError::Throttled(ADMIN_THROTTLE_SECS));
            }
            if !ct_eq(got.as_bytes(), hash.as_bytes()) {
                a.failed_logins = a.failed_logins.saturating_add(1);
                a.last_failed = Some(at);
                if a.failed_logins >= LOCK_AFTER && !last_admin {
                    a.locked_until = Some(at + LOCK_SECS);
                }
                return Err(AuthError::BadCredentials);
            }
            a.failed_logins = 0;
            a.locked_until = None;
            a.last_failed = None;
            a.last_login = Some(at);
            a.clone()
        };
        // A failed save is not a reason to refuse someone who typed the right password.
        let _ = self.save();
        Ok(out)
    }
}

/* ---------------------------------- sessions ---------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub user: String,
    pub role: Role,
    pub started: u64,
    pub must_change: bool,
    pub scope: Option<Vec<String>>,
    /// Unix seconds this session was last used, to the minute (see `Sessions::TOUCH_EVERY`).
    /// 0 for a session written before this field existed: `started` stands in for it.
    #[serde(default)]
    pub last_seen: u64,
    /// Made by the Zabbix frame's sign-in. The frame holds its token in page memory only, so
    /// every reload leaves the old one behind, never to be used again; housekeeping expires
    /// those after a day without use. Absent in a session written before this field existed.
    #[serde(default)]
    pub frame: bool,
}

impl Session {
    /// When this session was last known to be in use.
    pub fn seen(&self) -> u64 {
        if self.last_seen > 0 { self.last_seen } else { self.started }
    }
}

/// What housekeeping may end, and when. See `Sessions::reap`.
#[derive(Clone, Debug)]
pub struct SessionPolicy {
    /// A Zabbix-frame session unused this long is ended.
    pub frame_idle_secs: u64,
    /// Any other session unused this long is ended; `None` is the default — never.
    pub idle_secs: Option<u64>,
    /// A session used within this long is somebody at the keyboard: nothing ends it.
    pub active_secs: u64,
}

/// One session housekeeping ended (or, on a dry run, would). No token, no hash.
#[derive(Clone, Debug, PartialEq)]
pub struct Reaped {
    pub user: String,
    pub role: Role,
    pub frame: bool,
    pub idle_secs: u64,
    pub reason: &'static str,
}

/// How many sessions there are.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionStats {
    pub total: usize,
    pub frame: usize,
}

/// Live sessions. A session ends when the person signs out, or when an administrator
/// removes, disables or demotes the account, changes its password, or Zabbix withdraws
/// it — never on its own: no idle timeout, and a restart of the core keeps every session.
///
/// Signing people out by itself was the most-reported annoyance: every upgrade, every
/// container restart and every eight idle hours sent everyone back to the login screen
/// mid-task. So sessions are kept in `sessions.json` beside `users.json` (hosted only,
/// 0600), and only a SHA-256 of each token is written: the file lets the core recognise a
/// token it issued, and a copy of the file is worth nothing to anyone who reads it.
pub struct Sessions {
    /// Token hash → session.
    map: RwLock<HashMap<String, Session>>,
    path: Option<PathBuf>,
    /// When the file was last written, unix seconds.
    last_saved: AtomicU64,
    /// A `last_seen` has moved in memory since the file was written.
    touched: AtomicBool,
    /// One writer of the file at a time.
    saving: Mutex<()>,
}

impl Default for Sessions {
    fn default() -> Self {
        Sessions::open(None)
    }
}

impl Sessions {
    /// The sessions kept at `path` (none: in memory only, as the desktop app runs). A file
    /// that cannot be read starts empty; it never stops the core.
    pub fn open(path: Option<PathBuf>) -> Sessions {
        let map = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<HashMap<String, Session>>(&s).ok())
            .unwrap_or_default();
        Sessions { map: RwLock::new(map), path, last_saved: AtomicU64::new(now()), touched: AtomicBool::new(false), saving: Mutex::new(()) }
    }

    /// How coarsely `last_seen` follows use: a session in constant use takes the write lock
    /// once a minute, not once a request.
    pub const TOUCH_EVERY: u64 = 60;
    /// The file is rewritten for a moved `last_seen` at most this often.
    pub const PERSIST_EVERY: u64 = 600;

    fn save(&self) {
        let _one_writer = self.saving.lock();
        self.write_file(now());
    }

    /// Write the file; `at` is the clock the caller is on, remembered as the time of the write.
    fn write_file(&self, at: u64) {
        let Some(p) = &self.path else { return };
        self.last_saved.store(at, Ordering::Relaxed);
        self.touched.store(false, Ordering::Relaxed);
        let Ok(body) = serde_json::to_string(&*self.map.read()) else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = p.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        let wrote = (|| -> std::io::Result<()> {
            use std::io::Write as _;
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut f = o.open(&tmp)?;
            f.write_all(body.as_bytes())?;
            f.sync_all()?;
            std::fs::rename(&tmp, p)
        })();
        if let Err(e) = wrote {
            let _ = std::fs::remove_file(&tmp);
            tracing::warn!(error = %e, "sessions could not be saved; they still work until the core restarts");
        }
    }

    pub fn begin(&self, account: &Account) -> String {
        self.begin_kind(account, false)
    }

    /// A session for the Zabbix frame, which keeps its token in page memory and so leaves
    /// one behind per reload. Otherwise the same.
    pub fn begin_frame(&self, account: &Account) -> String {
        self.begin_kind(account, true)
    }

    fn begin_kind(&self, account: &Account, frame: bool) -> String {
        let token = random_hex(32);
        let at = now();
        let s = Session {
            user: account.name.clone(),
            role: account.role,
            started: at,
            must_change: account.must_change,
            scope: account.scope.clone(),
            last_seen: at,
            frame,
        };
        self.map.write().insert(token_hash(&token), s);
        self.save();
        token
    }

    /// The session this token names, if it is still live. Using one moves its `last_seen`.
    pub fn resolve(&self, token: &str) -> Option<Session> {
        self.resolve_at(token, now())
    }

    /// `resolve` at a given time (seconds).
    pub fn resolve_at(&self, token: &str, at: u64) -> Option<Session> {
        if token.is_empty() {
            return None;
        }
        let h = token_hash(token);
        let mut s = self.map.read().get(&h).cloned()?;
        // The common case — seen within the minute — costs a read lock and a compare.
        if at.saturating_sub(s.seen()) >= Self::TOUCH_EVERY {
            if let Some(m) = self.map.write().get_mut(&h) {
                m.last_seen = at;
                s.last_seen = at;
                self.touched.store(true, Ordering::Relaxed);
            }
            self.persist_if_due(at);
        }
        Some(s)
    }

    /// Write a moved `last_seen` to disk, if the last write is old enough. Never waits for
    /// another writer: if one is at it, that write carries the change.
    fn persist_if_due(&self, at: u64) {
        if self.path.is_none() || !self.touched.load(Ordering::Relaxed)
            || at.saturating_sub(self.last_saved.load(Ordering::Relaxed)) < Self::PERSIST_EVERY {
            return;
        }
        if let Some(_one_writer) = self.saving.try_lock() {
            self.write_file(at);
        }
    }

    /// Write whatever `last_seen` has moved since the file was last written.
    pub fn flush(&self) {
        if self.touched.load(Ordering::Relaxed) {
            self.save();
        }
    }

    pub fn stats(&self) -> SessionStats {
        let m = self.map.read();
        SessionStats { total: m.len(), frame: m.values().filter(|s| s.frame).count() }
    }

    /// End the sessions nobody is using any more, and return what ended.
    ///
    /// * a Zabbix-frame session unused for `frame_idle_secs`;
    /// * any other session unused for `idle_secs`, when that is set (it is not, by default:
    ///   sessions do not time out on their own, and there is no cap on how many one account
    ///   may hold — nobody is signed out for having signed in often).
    ///
    /// There is no count cap for frame sessions either: a frame reload orphans its token, and
    /// the only ones that can be ended are those unused for `frame_idle_secs`, which the first
    /// rule already ends. A frame session used within that time is kept however many there are.
    ///
    /// A session used within `active_secs` is never ended, whichever rule picked it, and
    /// neither is the one whose token is `protect` — the administrator who pressed the
    /// button. With `dry_run` nothing is ended.
    pub fn reap(&self, at: u64, p: &SessionPolicy, protect: Option<&str>, dry_run: bool) -> Vec<Reaped> {
        let keep = protect.filter(|t| !t.is_empty()).map(token_hash);
        let mut doomed: Vec<(String, Reaped)> = vec![];
        {
            let map = self.map.read();
            let idle_of = |s: &Session| at.saturating_sub(s.seen());
            let reap_of = |s: &Session, reason: &'static str| Reaped {
                user: s.user.clone(), role: s.role, frame: s.frame, idle_secs: idle_of(s), reason,
            };
            let mut taken: std::collections::HashSet<&String> = Default::default();
            for (h, s) in map.iter() {
                if keep.as_ref() == Some(h) || idle_of(s) < p.active_secs {
                    continue;
                }
                let why = if s.frame && idle_of(s) >= p.frame_idle_secs {
                    Some("idle Zabbix-frame session")
                } else if !s.frame && p.idle_secs.is_some_and(|i| idle_of(s) >= i) {
                    Some("idle session")
                } else {
                    None
                };
                if let Some(why) = why {
                    taken.insert(h);
                    doomed.push((h.clone(), reap_of(s, why)));
                }
            }
        }
        if !dry_run && !doomed.is_empty() {
            {
                let mut map = self.map.write();
                for (h, _) in &doomed {
                    map.remove(h);
                }
            }
            self.save();
        }
        doomed.sort_by(|a, b| a.1.user.cmp(&b.1.user).then(b.1.idle_secs.cmp(&a.1.idle_secs)));
        doomed.into_iter().map(|(_, r)| r).collect()
    }

    /// The same as `resolve`: kept for the event stream's periodic re-check, which asks
    /// whether the session still exists (it ends on sign-out or an admin's change).
    pub fn peek(&self, token: &str) -> Option<Session> {
        self.resolve(token)
    }

    pub fn end(&self, token: &str) {
        if self.map.write().remove(&token_hash(token)).is_some() {
            self.save();
        }
    }

    /// The forced change is over for any session this account already holds.
    ///
    /// Needed because a session caches the flag it was created with: without this the
    /// operator changes their password, the account is updated, and the session they are
    /// sitting in is still locked to the change-password screen.
    pub fn clear_must_change(&self, user: &str) {
        for s in self.map.write().values_mut() {
            if s.user.eq_ignore_ascii_case(user) {
                s.must_change = false;
            }
        }
        self.save();
    }

    /// Rewrite the role and scope of every live session for one account. Used when Zabbix
    /// has just said something new about them: the change applies to the tab they already
    /// have open, not only to the next one.
    pub fn refresh_for(&self, user: &str, role: Role, scope: Option<Vec<String>>) {
        let mut changed = false;
        for s in self.map.write().values_mut() {
            if s.user.eq_ignore_ascii_case(user) && (s.role != role || s.scope != scope) {
                s.role = role;
                s.scope = scope.clone();
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    /// Every session for one account, gone. Used when an account is removed, disabled or
    /// demoted — otherwise the change does not take effect until they happen to log out.
    pub fn end_all_for(&self, user: &str) {
        let before = self.map.read().len();
        self.map.write().retain(|_, s| !s.user.eq_ignore_ascii_case(user));
        if self.map.read().len() != before {
            self.save();
        }
    }

    pub fn count(&self) -> usize {
        self.map.read().len()
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

    /// Housekeeping: delete the tokens that expired more than `grace_secs` ago. An expired
    /// token is already refused; this only stops the list growing. A token with no expiry is
    /// never touched. Returns what went (or would, on a dry run).
    pub fn sweep_expired(&self, at: u64, grace_secs: u64, dry_run: bool) -> Result<Vec<ApiToken>, AuthError> {
        let gone = |t: &ApiToken| t.expires_at.is_some_and(|e| at >= e.saturating_add(grace_secs));
        let out: Vec<ApiToken> = self.tokens.read().iter().filter(|t| gone(t)).cloned().collect();
        if out.is_empty() || dry_run {
            return Ok(out);
        }
        self.tokens.write().retain(|t| !gone(t));
        self.save()?;
        Ok(out)
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
        // Blocked whatever the password: a different answer for the right one would say
        // which guess was right.
        assert_eq!(s.verify("bob", "correct-horse").unwrap_err(), AuthError::Blocked);
        assert_eq!(s.verify("bob", "wrong-horse!").unwrap_err(), AuthError::Blocked);
        assert!(s.is_blocked("BOB"));
    }

    #[test]
    fn wrong_passwords_lock_an_account_and_an_admin_unlocks_it() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.add("bob", "correct-horse", Role::User).unwrap();
        for _ in 0..LOCK_AFTER {
            assert_eq!(s.verify("bob", "wrong-horse!").unwrap_err(), AuthError::BadCredentials);
        }
        // Now every password is refused the same way, the right one included.
        assert_eq!(s.verify("bob", "correct-horse").unwrap_err(), AuthError::Locked);
        assert_eq!(s.verify("bob", "wrong-horse!").unwrap_err(), AuthError::Locked);
        let bob = s.list().into_iter().find(|a| a.name == "bob").unwrap();
        assert_eq!(bob.failed_logins, LOCK_AFTER);
        assert!(bob.locked_until.is_some() && bob.public()["lockedUntil"].is_u64());
        s.set_locked("bob", false).unwrap();
        let ok = s.verify("bob", "correct-horse").unwrap();
        assert_eq!(ok.failed_logins, 0);
        assert!(ok.last_login.is_some());
    }

    #[test]
    fn the_last_admin_is_slowed_not_locked_and_failures_are_not_written_down() {
        let dir = scratch();
        let path = dir.join("users.json");
        let s = UserStore::open_with_rounds(Some(path.clone()), 1);
        s.add("root", "correct-horse", Role::Admin).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        for _ in 0..LOCK_AFTER {
            assert_eq!(s.verify("root", "wrong-horse!").unwrap_err(), AuthError::BadCredentials);
        }
        assert_eq!(s.verify("root", "wrong-horse!").unwrap_err(), AuthError::Throttled(ADMIN_THROTTLE_SECS));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "a failure touches memory only");
        // Not locked, but slowed: inside the window even the right password waits its turn.
        assert_eq!(s.verify("root", "correct-horse").unwrap_err(), AuthError::Throttled(ADMIN_THROTTLE_SECS));
        assert!(!s.list()[0].is_locked(now()), "the only admin is never locked");
        // After the window, the right password opens it.
        s.accounts.write()[0].last_failed = Some(now() - ADMIN_THROTTLE_SECS);
        assert!(s.verify("root", "correct-horse").is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_admin_lock_holds_until_unlocked_and_the_last_admin_cannot_be_locked() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.add("bob", "correct-horse", Role::User).unwrap();
        s.set_locked("bob", true).unwrap();
        assert_eq!(s.verify("bob", "correct-horse").unwrap_err(), AuthError::Locked);
        assert_eq!(s.set_locked("root", true), Err(AuthError::LastAdmin));
        s.set_locked("bob", false).unwrap();
        assert!(s.verify("bob", "correct-horse").is_ok());
    }

    #[test]
    fn sign_ins_are_logged_newest_first_with_their_code_and_never_a_password() {
        let s = store();
        s.record_login("bob", "password", Err(&AuthError::BadCredentials));
        s.record_login("bob", "password", Ok(()));
        let log = s.logins();
        assert!(log[0].ok && log[0].code.is_empty());
        assert_eq!((log[1].kind.as_str(), log[1].code.as_str()), ("bad_credentials", "EP-102"));
        let long = "x".repeat(200);
        s.record_login(&long, "zabbix", Ok(()));
        assert_eq!(s.logins()[0].name.len(), 64);
        for _ in 0..LOGIN_LOG_LEN + 5 {
            s.record_login("y", "password", Ok(()));
        }
        assert_eq!(s.logins().len(), LOGIN_LOG_LEN);
    }

    #[test]
    fn a_role_set_here_on_a_zabbix_account_is_pinned_and_survives_its_sign_ins() {
        let dir = std::env::temp_dir().join(format!("ep-pin-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("users.json");
        let s = UserStore::open_with_rounds(Some(file.clone()), 1);
        s.add("root", "correct-horse", Role::Admin).unwrap();
        let a = s.upsert_external("ada@zabbix", "zabbix", Role::Operator, None).unwrap();
        assert!(!a.role_pinned, "a sign-in alone pins nothing");
        // Zabbix still decides while nobody here has.
        assert_eq!(s.upsert_external("ada@zabbix", "zabbix", Role::User, None).unwrap().role, Role::User);
        s.set_role("ada@zabbix", Role::Admin).unwrap();
        let pinned = s.list().into_iter().find(|a| a.name == "ada@zabbix").unwrap();
        assert!(pinned.role_pinned && pinned.role == Role::Admin);
        assert_eq!(pinned.public()["rolePinned"], serde_json::json!(true));
        // The next sign-in says Operator; the admin's choice stands, the scope still follows.
        let after = s.upsert_external("ada@zabbix", "zabbix", Role::Operator, Some(vec!["ES a".into()])).unwrap();
        assert_eq!((after.role, after.role_pinned), (Role::Admin, true));
        assert_eq!(after.scope, Some(vec!["ES a".to_string()]));
        // And it is written down, not just held in memory.
        let reread = UserStore::open_with_rounds(Some(file), 1);
        assert!(reread.list().into_iter().find(|a| a.name == "ada@zabbix").unwrap().role_pinned);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_local_accounts_role_change_pins_nothing() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.add("bob", "correct-horse", Role::User).unwrap();
        s.set_role("bob", Role::Operator).unwrap();
        let bob = s.list().into_iter().find(|a| a.name == "bob").unwrap();
        assert!(!bob.role_pinned);
        assert!(matches!(s.unpin_role("bob"), Err(AuthError::Weak(_))), "a local account has nothing to follow");
        assert_eq!(s.unpin_role("nobody"), Err(AuthError::NotFound("nobody".into())));
    }

    #[test]
    fn unpinning_hands_the_role_back_to_zabbix_at_the_next_sign_in() {
        let s = store();
        s.add("root", "correct-horse", Role::Admin).unwrap();
        s.upsert_external("ada@zabbix", "zabbix", Role::Operator, None).unwrap();
        s.set_role("ada@zabbix", Role::Admin).unwrap();
        s.unpin_role("ada@zabbix").unwrap();
        let now = s.list().into_iter().find(|a| a.name == "ada@zabbix").unwrap();
        assert_eq!((now.role, now.role_pinned), (Role::Admin, false), "nothing changes until they sign in");
        assert_eq!(s.upsert_external("ada@zabbix", "zabbix", Role::Operator, None).unwrap().role, Role::Operator);
        // Unpinning what is not pinned is not an error.
        assert!(s.unpin_role("ada@zabbix").is_ok());
    }

    #[test]
    fn the_last_admin_cannot_be_handed_back_to_zabbix() {
        // Its next sign-in could demote it, leaving nobody able to administer.
        let s = store();
        s.upsert_external("ada@zabbix", "zabbix", Role::Operator, None).unwrap();
        s.set_role("ada@zabbix", Role::Admin).unwrap();
        assert_eq!(s.unpin_role("ada@zabbix"), Err(AuthError::LastAdmin));
        assert_eq!(s.set_role("ada@zabbix", Role::Operator), Err(AuthError::LastAdmin), "nor demoted here");
        s.add("root", "correct-horse", Role::Admin).unwrap();
        assert!(s.unpin_role("ada@zabbix").is_ok(), "with a second admin it no longer carries the install");
    }

    #[test]
    fn unpinning_is_an_admins_message() {
        assert_eq!(required_role("USER_UNPIN_ROLE"), Some(Role::Admin));
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
    fn a_fresh_store_opens_with_the_shipped_account_and_is_seeded_once() {
        let a = store();
        let seeded = seed_first_account(&a, None).unwrap();
        assert!(!seeded.from_override && seeded.override_error.is_none());
        let acct = a.verify(DEFAULT_USER, DEFAULT_PASSWORD).unwrap();
        assert!(acct.role == Role::Admin && !acct.must_change, "usable at once, not fenced");
        assert!(a.default_unchanged());
        assert_eq!(a.verify(DEFAULT_USER, "loginme").unwrap_err(), AuthError::BadCredentials);
        // Only ever the first account: a store with accounts is left alone.
        assert!(seed_first_account(&a, None).is_none());
        assert_eq!(a.list().len(), 1);
        // The shipped password is below the minimum on purpose, so it cannot be chosen
        // again once replaced.
        assert!(DEFAULT_PASSWORD.chars().count() < MIN_PASSWORD);
        assert!(matches!(a.set_password(DEFAULT_USER, DEFAULT_PASSWORD), Err(AuthError::Weak(_))));
        a.set_password(DEFAULT_USER, "a-real-password-now").unwrap();
        assert!(!a.default_unchanged());
        assert_eq!(a.verify(DEFAULT_USER, DEFAULT_PASSWORD).unwrap_err(), AuthError::BadCredentials);
    }

    #[test]
    fn an_operator_file_sets_the_first_password_instead() {
        let dir = scratch();
        let over = dir.join("pw");
        std::fs::write(&over, "operator-chosen-pass\n").unwrap();
        let s = store();
        let seeded = seed_first_account(&s, Some(&over)).unwrap();
        assert!(seeded.from_override && seeded.override_error.is_none());
        assert!(!s.verify(DEFAULT_USER, "operator-chosen-pass").unwrap().must_change);
        assert!(s.verify(DEFAULT_USER, DEFAULT_PASSWORD).is_err(), "the shipped password must not also open it");
        assert!(!s.default_unchanged());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_short_operator_file_is_refused_and_the_shipped_password_used_instead() {
        let dir = scratch();
        let over = dir.join("pw");
        std::fs::write(&over, "short\n").unwrap();
        assert!(matches!(read_initial_password_file(&over), Err(AuthError::Weak(_))));
        let s = store();
        let seeded = seed_first_account(&s, Some(&over)).unwrap();
        assert!(!seeded.from_override);
        assert!(seeded.override_error.as_deref().unwrap().contains("at least"));
        assert!(s.verify(DEFAULT_USER, "short").is_err());
        assert!(s.verify(DEFAULT_USER, DEFAULT_PASSWORD).is_ok(), "never an empty store");
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
    fn an_operator_reads_every_cluster_and_changes_none() {
        for (m, p) in [("PUT", "/idx"), ("POST", "/idx/_doc"), ("DELETE", "/idx"), ("POST", "/_snapshot/r/s/_restore"),
                       ("PATCH", "/x"), ("POST", "/_bulk"), ("POST", "/idx/_delete_by_query")] {
            assert!(authorize(Role::Operator, "ES", m, p).is_err(), "{m} {p} must be refused to an operator");
        }
        assert!(authorize(Role::Operator, "WRITE_UNLOCK", "", "").is_err());
        for r in [Role::Operator, Role::User] {
            assert!(authorize(r, "ES", "GET", "/_cat/indices").is_ok());
            assert!(authorize(r, "ES", "HEAD", "/idx").is_ok());
            // Searches sent as POST are reads.
            assert!(authorize(r, "ES", "POST", "/logstash-*/_search").is_ok());
            assert!(authorize(r, "ES", "POST", "/logstash-*/_count?q=x").is_ok());
        }
        assert!(authorize(Role::Admin, "ES", "PUT", "/idx").is_ok());
        assert!(authorize(Role::Admin, "WRITE_UNLOCK", "", "").is_ok());
    }

    #[test]
    fn a_user_is_read_only_everywhere_that_matters() {
        for t in ["WRITE_UNLOCK", "CONFIG_READ", "CONFIG_WRITE", "VAULT_GET", "TRUST_CERT", "PRIME", "USER_ADD", "TOKEN_CREATE",
                  "CLUSTER_SAVE", "AUTOMATIONS_SAVE", "ZABBIX_ROLEMAP_GET", "ZABBIX_ROLEMAP_SET",
                  "CREDENTIAL_STATUS", "CREDENTIAL_SET", "CREDENTIAL_CLEAR"] {
            assert!(authorize(Role::User, t, "", "").is_err(), "{t} must not be open to a user");
            assert!(authorize(Role::Admin, t, "", "").is_ok(), "{t} must be open to an admin");
        }
    }

    #[test]
    fn an_operator_saves_a_cluster_but_neither_reads_nor_writes_the_file() {
        assert_eq!(required_role("CLUSTER_SAVE"), Some(Role::Operator));
        assert_eq!(required_role("AUTOMATIONS_SAVE"), Some(Role::Operator));
        assert!(authorize(Role::Operator, "CLUSTER_SAVE", "", "").is_ok());
        assert!(authorize(Role::Operator, "AUTOMATIONS_SAVE", "", "").is_ok());
        assert!(authorize(Role::User, "CLUSTER_SAVE", "", "").is_err());
        assert!(authorize(Role::User, "AUTOMATIONS_SAVE", "", "").is_err());
        for t in ["CONFIG_READ", "CONFIG_WRITE", "FILE_WRITE", "SEAL", "PRIME", "ZABBIX_ROLEMAP_GET", "ZABBIX_ROLEMAP_SET"] {
            assert!(authorize(Role::Operator, t, "", "").is_err(), "{t} must stay an admin's");
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

    // Regression: sessions ended on their own — every core restart (in memory only) and
    // every eight idle hours (IDLE_TIMEOUT) sent everyone back to the login screen.
    // Reported 2026-10-14: "automatically I am logged out — never log out any user".
    #[test]
    fn a_session_survives_a_restart_and_never_times_out() {
        let s = store();
        s.add("alice", "correct-horse", Role::User).unwrap();
        let acct = s.verify("alice", "correct-horse").unwrap();
        let dir = std::env::temp_dir().join(format!("ep-sessions-{}-{}", std::process::id(), random_hex(4)));
        let path = dir.join("sessions.json");
        let tok = Sessions::open(Some(path.clone())).begin(&acct);
        // A new core reading the same file: the session is still there.
        let after = Sessions::open(Some(path.clone()));
        assert_eq!(after.resolve(&tok).unwrap().user, "alice", "a restart must not sign anyone out");
        // Only a hash of the token is on disk.
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(!body.contains(&tok), "the token itself must never be written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Signing out is the way it ends, and that is kept too.
        after.end(&tok);
        assert!(Sessions::open(Some(path.clone())).resolve(&tok).is_none());
        assert!(after.resolve("").is_none());
        let _ = std::fs::remove_dir_all(&dir);
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

    /* ------------------------- housekeeping: session expiry ------------------------- */

    fn policy() -> SessionPolicy {
        SessionPolicy { frame_idle_secs: 24 * 3600, idle_secs: None, active_secs: 600 }
    }

    fn account(name: &str, role: Role) -> Account {
        let s = store();
        s.add(name, "correct-horse", role).unwrap();
        s.verify(name, "correct-horse").unwrap()
    }

    #[test]
    fn a_zabbix_frame_session_ends_after_a_day_unused_and_an_ordinary_one_does_not() {
        let a = account("alice", Role::User);
        let ss = Sessions::default();
        let (normal, frame) = (ss.begin(&a), ss.begin_frame(&a));
        let t0 = now();
        // 23 hours on: both stay.
        assert!(ss.reap(t0 + 23 * 3600, &policy(), None, false).is_empty());
        // 25 hours on: the frame session goes, the ordinary one is a person's browser tab.
        let gone = ss.reap(t0 + 25 * 3600, &policy(), None, false);
        assert_eq!(gone.len(), 1);
        assert!(gone[0].frame && gone[0].user == "alice" && gone[0].idle_secs >= 25 * 3600 - 2);
        assert!(ss.resolve_at(&frame, t0 + 25 * 3600).is_none());
        assert!(ss.resolve_at(&normal, t0 + 25 * 3600).is_some());
        // And a year on, still: no timeout unless one was asked for.
        assert!(ss.reap(t0 + 365 * 86_400, &policy(), None, false).is_empty());
        assert!(ss.resolve_at(&normal, t0 + 365 * 86_400).is_some());
    }

    #[test]
    fn session_idle_days_ends_ordinary_sessions_too() {
        let a = account("alice", Role::User);
        let ss = Sessions::default();
        let tok = ss.begin(&a);
        let t0 = now();
        let p = SessionPolicy { idle_secs: Some(30 * 86_400), ..policy() };
        assert!(ss.reap(t0 + 29 * 86_400, &p, None, false).is_empty());
        // Used on day 29: the clock starts again.
        assert!(ss.resolve_at(&tok, t0 + 29 * 86_400).is_some());
        assert!(ss.reap(t0 + 58 * 86_400, &p, None, false).is_empty(), "29 days since it was last used");
        let gone = ss.reap(t0 + 60 * 86_400, &p, None, false);
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].reason, "idle session");
        assert!(ss.resolve_at(&tok, t0 + 60 * 86_400).is_none());
    }

    #[test]
    fn a_session_in_use_is_never_ended_whatever_the_rules_say() {
        let a = account("alice", Role::Admin);
        let ss = Sessions::default();
        let (busy, stale) = (ss.begin_frame(&a), ss.begin_frame(&a));
        let t0 = now();
        // A rule that would end every idle session at once; "idle" means ten minutes.
        let p = SessionPolicy { frame_idle_secs: 0, idle_secs: Some(0), active_secs: 600 };
        let at = t0 + 3600;
        assert!(ss.resolve_at(&busy, at - 120).is_some(), "used two minutes ago");
        let gone = ss.reap(at, &p, None, false);
        assert_eq!(gone.len(), 1, "only the unused one: {gone:?}");
        assert!(ss.resolve_at(&busy, at).is_some());
        assert!(ss.resolve_at(&stale, at).is_none());
    }

    #[test]
    fn the_session_of_whoever_pressed_the_button_is_protected() {
        let a = account("alice", Role::Admin);
        let ss = Sessions::default();
        let mine = ss.begin_frame(&a);
        let other = ss.begin_frame(&a);
        let at = now() + 3 * 86_400;
        let gone = ss.reap(at, &policy(), Some(&mine), false);
        assert_eq!(gone.len(), 1);
        assert!(ss.resolve_at(&other, at).is_none() && ss.resolve_at(&mine, at).is_some());
    }

    #[test]
    fn an_account_with_sixty_ordinary_sessions_keeps_all_sixty() {
        let a = account("alice", Role::User);
        let ss = Sessions::default();
        let t0 = now();
        let toks: Vec<String> = (0..60).map(|_| ss.begin(&a)).collect();
        // Not a minute, not a year, not a decade: nothing signs anyone out unless SESSION_IDLE_DAYS says so.
        for later in [3600, 30 * 86_400, 365 * 86_400, 3650 * 86_400] {
            assert!(ss.reap(t0 + later, &policy(), None, false).is_empty(), "after {later} s");
        }
        assert!(toks.iter().all(|t| ss.resolve_at(t, t0 + 3650 * 86_400).is_some()));
        assert_eq!(ss.count(), 60);
    }

    #[test]
    fn frame_sessions_used_within_a_day_are_kept_however_many_and_idle_ones_go_with_ordinary_ones_untouched() {
        let a = account("alice", Role::User);
        let ss = Sessions::default();
        let t0 = now();
        let ordinary: Vec<String> = (0..60).map(|_| ss.begin(&a)).collect();
        let frames: Vec<String> = (0..60).map(|_| ss.begin_frame(&a)).collect();
        assert!(ss.reap(t0 + 23 * 3600, &policy(), None, false).is_empty(), "sixty frame sessions, all used within the day");
        // Thirty of them are used again on the second day; thirty are orphans.
        for f in &frames[..30] { ss.resolve_at(f, t0 + 30 * 3600); }
        let gone = ss.reap(t0 + 40 * 3600, &policy(), None, false);
        assert_eq!(gone.len(), 30);
        assert!(gone.iter().all(|g| g.frame && g.reason == "idle Zabbix-frame session"));
        assert!(frames[..30].iter().all(|f| ss.resolve_at(f, t0 + 40 * 3600).is_some()), "used within 24 h: kept");
        assert!(frames[30..].iter().all(|f| ss.resolve_at(f, t0 + 40 * 3600).is_none()));
        assert!(ordinary.iter().all(|t| ss.resolve_at(t, t0 + 40 * 3600).is_some()), "ordinary sessions are never trimmed");
    }

    #[test]
    fn last_seen_follows_use_by_the_minute_and_reaches_the_disk_at_most_every_ten_minutes() {
        let a = account("alice", Role::User);
        let dir = std::env::temp_dir().join(format!("ep-sess-seen-{}-{}", std::process::id(), random_hex(4)));
        let path = dir.join("sessions.json");
        let ss = Sessions::open(Some(path.clone()));
        let before = now();
        let tok = ss.begin(&a);
        let after = now();
        let seen_on_disk = || -> u64 {
            let m: HashMap<String, Session> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            m.values().next().unwrap().last_seen
        };
        // Read the start back rather than calling now() again: a second can tick between
        // begin() and the next now(), which failed this test on CI (left 1792513109, right ...110).
        let t0 = seen_on_disk();
        assert!((before..=after).contains(&t0), "written when it began: {t0} not in {before}..={after}");
        // A busy session: forty requests in a minute change nothing, in memory or on disk.
        for i in 0..40 { ss.resolve_at(&tok, t0 + i); }
        assert_eq!(ss.resolve_at(&tok, t0 + 59).unwrap().last_seen, t0, "inside the minute: not touched");
        // A minute on it moves in memory, but the file waits.
        assert_eq!(ss.resolve_at(&tok, t0 + 120).unwrap().last_seen, t0 + 120);
        assert_eq!(seen_on_disk(), t0, "not rewritten for a minute's movement");
        // Past ten minutes since the file was written, the next touch writes it.
        ss.resolve_at(&tok, t0 + 700);
        assert_eq!(seen_on_disk(), t0 + 700);
        // flush() writes a pending move on demand.
        ss.resolve_at(&tok, t0 + 800);
        assert_eq!(seen_on_disk(), t0 + 700);
        ss.flush();
        assert_eq!(seen_on_disk(), t0 + 800);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sessions_file_from_before_last_seen_still_loads_and_counts_from_its_start() {
        let dir = std::env::temp_dir().join(format!("ep-sess-legacy-{}-{}", std::process::id(), random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.json");
        let hash = token_hash("legacy-token");
        let old = format!(r#"{{"{hash}":{{"user":"alice","role":"user","started":1000,"must_change":false,"scope":null}}}}"#);
        std::fs::write(&path, old).unwrap();
        let ss = Sessions::open(Some(path));
        let before = ss.map.read().get(&hash).cloned().unwrap();
        assert_eq!((before.last_seen, before.frame, before.seen()), (0, false, 1000));
        // Unclassified, so it is an ordinary session: only SESSION_IDLE_DAYS can end it.
        assert!(ss.reap(now(), &policy(), None, false).is_empty());
        let s = ss.resolve("legacy-token").unwrap();
        assert!(s.last_seen > 1000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reaped_session_stays_gone_after_a_restart() {
        let a = account("alice", Role::User);
        let dir = std::env::temp_dir().join(format!("ep-sess-reap-{}-{}", std::process::id(), random_hex(4)));
        let path = dir.join("sessions.json");
        let ss = Sessions::open(Some(path.clone()));
        let frame = ss.begin_frame(&a);
        let keep = ss.begin(&a);
        assert_eq!(ss.reap(now() + 2 * 86_400, &policy(), None, false).len(), 1);
        let again = Sessions::open(Some(path.clone()));
        assert!(again.resolve(&frame).is_none() && again.resolve(&keep).is_some());
        assert_eq!(again.stats(), SessionStats { total: 1, frame: 0 });
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn tokens_expired_for_over_thirty_days_are_deleted_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("elasticpro-toksweep-{}", random_hex(8)));
        let path = dir.join("tokens.json");
        let ts = TokenStore::open(Some(path.clone()));
        let (old, recent, forever, live) = (
            ts.create("old", Role::User, Some(1)).unwrap(),
            ts.create("recent", Role::User, Some(20)).unwrap(),
            ts.create("forever", Role::Admin, None).unwrap(),
            ts.create("live", Role::Guest, Some(90)).unwrap(),
        );
        let t = now();
        let grace = 30 * 86_400;
        // 45 days on: "old" expired on day 1 (44 days ago), "recent" on day 20 (25 days ago).
        let at = t + 45 * 86_400;
        let dry = ts.sweep_expired(at, grace, true).unwrap();
        assert_eq!(dry.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["old"]);
        assert_eq!(ts.list().len(), 4, "a dry run deletes nothing");
        let gone = ts.sweep_expired(at, grace, false).unwrap();
        assert_eq!(gone.len(), 1);
        let names: Vec<String> = ts.list().into_iter().map(|x| x.name).collect();
        assert_eq!(names, vec!["recent", "forever", "live"]);
        // Kept: a token with no expiry, one still valid, and one expired less than 30 days ago.
        assert_eq!(ts.verify(&forever), Some(Role::Admin));
        assert_eq!(ts.verify(&live), Some(Role::Guest));
        assert_eq!(ts.verify(&old), None);
        let _ = recent;
        // Deleted for good: a restart does not bring it back.
        assert_eq!(TokenStore::open(Some(path.clone())).list().len(), 3);
        // Later, "recent" crosses the line too.
        assert_eq!(ts.sweep_expired(t + 51 * 86_400, grace, false).unwrap().len(), 1);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("recent"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
