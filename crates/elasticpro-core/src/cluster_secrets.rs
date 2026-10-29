//! Elasticsearch passwords the Zabbix module hands over.
//!
//! Zabbix keeps a cluster's password as the Secret macro `{$ELASTICSEARCH.PASSWORD}` — on the
//! cluster host (that cluster's own), or as a global macro (the default every cluster shares).
//! Nothing can read a Secret macro back through the Zabbix API, this core included, so a cluster
//! whose password was kept that way used to be added with no usable credential and polled into a
//! 401 on every interval. When an admin types the password in Cluster Management, the module now
//! also sends it here (`POST /sso/zabbix/cluster-secret`, signed like the role lookup; see
//! `zbx_sso::SecretPush`). This keeps it:
//!
//! * per cluster, keyed by the cluster host's technical name — what the Zabbix sync knows the
//!   cluster by — and `"*"` for the default;
//! * encrypted at rest with AES-256-GCM, the cluster's name bound in as associated data, in
//!   `cluster-secrets.json` in the data directory (mode 0600);
//! * under a key from `ELASTICPRO_CLUSTER_SECRET_KEY_FILE` (or `ELASTICPRO_CLUSTER_SECRET_KEY`):
//!   64 hex characters, or any other string of at least 32 characters, hashed to 32 bytes. With
//!   neither set the key is made once, at random, in `cluster-secrets.key` beside the file
//!   (0600) and a warning says so: still encrypted, but a copy of the data directory then
//!   carries both halves. Deployments put the key outside it.
//!
//! What is never possible: reading a password back out through any message. The status is who
//! set it and when.
//!
//! Since 0.3.42 the hosted core keeps every credential of its own config clusters here too, not
//! only the ones Zabbix hands over: an admin types a cluster's password once (or the default
//! once, `"*"`, which every cluster without its own uses), and it is kept under
//! `cfg:<cluster id>` — the prefix keeps those apart from Zabbix host names. A credential that
//! is not a username and password (an API key, a bearer token) is kept as its whole
//! `Authorization` header, with `HEADER_USER` in place of a username; `header_for` turns either
//! kind into the header a request carries. Nothing outside this process ever sees one.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = "cluster-secrets.json";
pub const KEY_FILE: &str = "cluster-secrets.key";
/// The name the default credential is kept under.
pub const DEFAULT: &str = "*";
/// The longest password accepted.
pub const MAX_PASSWORD: usize = 1024;
/// The prefix of a config cluster's entry: `cfg:<cluster id>`.
pub const CONFIG_PREFIX: &str = "cfg:";
/// In place of a username: the entry is a whole `Authorization` header (API key, bearer token).
pub const HEADER_USER: &str = "(authorization header)";

/// The entry name of a config cluster.
pub fn config_key(id: &str) -> String {
    format!("{CONFIG_PREFIX}{id}")
}

/// One entry as a status line shows it: never the secret.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub name: String,
    /// The username, or `None` for a header entry (API key or bearer token).
    pub user: Option<String>,
    pub set_by: String,
    pub set_at: u64,
    /// The destination it is bound to; empty when unbound.
    pub bound: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Entry {
    user: String,
    /// `crypto::seal_with_key`, the cluster name as associated data.
    sealed: String,
    set_by: String,
    set_at: u64,
    /// The destination a config cluster's credential was kept for (address, route, certificate
    /// setting — `bridge::destination_of`). It is handed out for that destination only, so an
    /// entry left behind by a removed cluster cannot follow its name to another address. Empty
    /// for the default and for Zabbix's entries, which are not tied to one address.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    bound: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    v: u32,
    clusters: BTreeMap<String, Entry>,
}

/// A held credential. Its Debug never shows the password.
#[derive(Clone, PartialEq)]
pub struct Held {
    pub user: String,
    pub password: String,
}

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Held").field("user", &self.user).field("password", &"<redacted>").finish()
    }
}

pub struct ClusterSecrets {
    path: Option<PathBuf>,
    key: [u8; 32],
    stored: RwLock<Stored>,
    /// Why the store is not usable (a key that would not open the file), or None.
    problem: RwLock<Option<String>>,
}

/// A key from configuration: 64 hex characters as they are, anything else of 32+ characters hashed.
pub fn key_from(text: &str) -> Result<[u8; 32], String> {
    let t = text.trim();
    if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        let mut k = [0u8; 32];
        hex::decode_to_slice(t, &mut k).map_err(|e| e.to_string())?;
        return Ok(k);
    }
    if t.len() < 32 {
        return Err(format!("the cluster secret key is {} characters; at least 32 are required", t.len()));
    }
    Ok(Sha256::digest(t.as_bytes()).into())
}

/// A temp name of its own beside `path`: `<file>.<pid>.<nonce>.tmp`, so two writers never share one.
fn temp_name(path: &Path) -> PathBuf {
    let file = path.file_name().and_then(|f| f.to_str()).unwrap_or("secret");
    path.with_file_name(format!("{file}.{}.{}.tmp", std::process::id(), crate::auth::random_hex(8)))
}

/// Write `bytes` to `path` so that no other user can read them at any moment: the temp file is
/// created 0600 before a byte goes in (never written first and chmodded after, which left it
/// readable per the umask in between), created new (an existing file of that name is an error,
/// not something to write through), synced, then renamed over the target.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let tmp = temp_name(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let written = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

impl ClusterSecrets {
    /// In memory only, under a random key: what tests and the portable build get.
    pub fn in_memory() -> ClusterSecrets {
        let mut key = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut key);
        ClusterSecrets { path: None, key, stored: RwLock::new(Stored { v: 1, ..Default::default() }), problem: RwLock::new(None) }
    }

    /// The store in `dir`, its key from the environment or (failing that) beside it.
    pub fn open(dir: Option<&Path>) -> ClusterSecrets {
        let configured = std::env::var("ELASTICPRO_CLUSTER_SECRET_KEY").ok().filter(|v| !v.trim().is_empty())
            .or_else(|| std::env::var("ELASTICPRO_CLUSTER_SECRET_KEY_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok()));
        ClusterSecrets::open_with(dir, configured.as_deref())
    }

    /// `open`, with the configured key given rather than read from the environment.
    pub fn open_with(dir: Option<&Path>, configured_key: Option<&str>) -> ClusterSecrets {
        let Some(dir) = dir else { return ClusterSecrets::in_memory() };
        let mut problem = None;
        let key = match configured_key.map(key_from) {
            Some(Ok(k)) => k,
            Some(Err(why)) => {
                problem = Some(why.clone());
                tracing::warn!("cluster secrets: {why}; the passwords Zabbix hands over cannot be kept");
                [0u8; 32]
            }
            None => {
                let kp = dir.join(KEY_FILE);
                match std::fs::read_to_string(&kp).ok().and_then(|t| key_from(&t).ok()) {
                    Some(k) => k,
                    None => {
                        let mut k = [0u8; 32];
                        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut k);
                        if let Err(e) = write_private(&kp, hex::encode(k).as_bytes()) {
                            problem = Some(format!("cannot write {}: {e}", kp.display()));
                        }
                        tracing::warn!(key = %kp.display(),
                            "cluster secrets: no ELASTICPRO_CLUSTER_SECRET_KEY_FILE set, so the key was made beside the encrypted file; \
                             set one outside the data directory");
                        k
                    }
                }
            }
        };
        let path = dir.join(FILE);
        let stored = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Stored>(&b).ok()).unwrap_or(Stored { v: 1, ..Default::default() });
        let s = ClusterSecrets { path: Some(path), key, stored: RwLock::new(stored), problem: RwLock::new(problem) };
        // A key that opens none of what is kept is said once, at start: the file is left as it is.
        let bad = s.stored.read().clusters.iter().filter(|(n, e)| crate::crypto::open_with_key(&e.sealed, &s.key, n).is_err()).count();
        if bad > 0 {
            tracing::warn!(entries = bad, "cluster secrets: the key does not open {bad} kept password(s) — was the key changed?");
        }
        s
    }

    fn valid_name(cluster: &str) -> bool {
        let c = cluster.trim();
        !c.is_empty() && c.len() <= 128 && !c.chars().any(char::is_control) && c == cluster
    }

    /// Keep a password for `cluster` (`"*"` for the default). Replaces what was there.
    pub fn set(&self, cluster: &str, user: &str, password: &str, by: &str, now: u64) -> Result<(), String> {
        self.put(cluster, user, password, "", by, now)
    }

    fn put(&self, cluster: &str, user: &str, password: &str, bound: &str, by: &str, now: u64) -> Result<(), String> {
        if let Some(p) = self.problem.read().clone() {
            return Err(p);
        }
        if !ClusterSecrets::valid_name(cluster) {
            return Err("the cluster name is empty, too long or has control characters".into());
        }
        if password.is_empty() || password.len() > MAX_PASSWORD {
            return Err(format!("the password must be 1–{MAX_PASSWORD} bytes"));
        }
        let sealed = crate::crypto::seal_with_key(password, &self.key, cluster)?;
        let mut st = self.stored.write();
        st.v = 1;
        st.clusters.insert(cluster.to_string(), Entry { user: user.trim().to_string(), sealed, set_by: by.to_string(), set_at: now, bound: bound.to_string() });
        if let Some(p) = &self.path {
            let bytes = serde_json::to_vec_pretty(&*st).map_err(|e| e.to_string())?;
            write_private(p, &bytes).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
        }
        Ok(())
    }

    /// The credential held for exactly this cluster name — no fallback here; see `for_cluster`.
    pub fn get(&self, cluster: &str) -> Option<Held> {
        let st = self.stored.read();
        let e = st.clusters.get(cluster)?;
        let password = crate::crypto::open_with_key(&e.sealed, &self.key, cluster).ok()?;
        Some(Held { user: e.user.clone(), password })
    }

    /// The credential for a cluster host: its own when its password macro is on the host (an
    /// override), else the default — the order Zabbix itself resolves the macro in.
    pub fn for_cluster(&self, host: &str, password_on_host: bool) -> Option<Held> {
        if password_on_host { self.get(host) } else { self.get(DEFAULT) }
    }

    /// Who set it and when, never the password.
    pub fn status(&self, cluster: &str) -> Option<(String, u64)> {
        self.stored.read().clusters.get(cluster).map(|e| (e.set_by.clone(), e.set_at))
    }

    /// Keep a whole `Authorization` header for `cluster` (an API key or a bearer token, or a
    /// header a browser built). Replaces what was there.
    pub fn set_header(&self, cluster: &str, header: &str, by: &str, now: u64) -> Result<(), String> {
        let h = header.trim();
        if h.is_empty() || h.chars().any(char::is_control) {
            return Err("the credential is empty or has control characters".into());
        }
        self.set(cluster, HEADER_USER, h, by, now)
    }

    /// The `Authorization` header for exactly this entry: `Basic` from a username and
    /// password, or the header itself when that is what was kept.
    pub fn header_for(&self, cluster: &str) -> Option<String> {
        let held = self.get(cluster)?;
        if held.user == HEADER_USER {
            return Some(held.password);
        }
        use base64::Engine as _;
        Some(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", held.user, held.password))))
    }

    /// `set`, the entry bound to one destination: handed out by `header_at` for that one only.
    pub fn set_bound(&self, cluster: &str, user: &str, password: &str, bound: &str, by: &str, now: u64) -> Result<(), String> {
        self.put(cluster, user, password, bound, by, now)
    }

    /// `set_header`, bound to one destination.
    pub fn set_header_bound(&self, cluster: &str, header: &str, bound: &str, by: &str, now: u64) -> Result<(), String> {
        let h = header.trim();
        if h.is_empty() || h.chars().any(char::is_control) {
            return Err("the credential is empty or has control characters".into());
        }
        self.set_bound(cluster, HEADER_USER, h, bound, by, now)
    }

    /// The header for this entry when it may go to `destination`: an entry bound to another
    /// destination gives nothing (an unbound one goes anywhere — the default, Zabbix's).
    pub fn header_at(&self, cluster: &str, destination: &str) -> Option<String> {
        let ok = self.stored.read().clusters.get(cluster).is_some_and(|e| e.bound.is_empty() || e.bound == destination);
        if ok { self.header_for(cluster) } else { None }
    }

    /// The destination an entry is bound to (empty: unbound), or `None` without an entry.
    pub fn bound_of(&self, cluster: &str) -> Option<String> {
        self.stored.read().clusters.get(cluster).map(|e| e.bound.clone())
    }

    /// Bind an existing entry to a new destination (an admin moved the cluster deliberately).
    pub fn rebind(&self, cluster: &str, destination: &str, by: &str, now: u64) -> Result<bool, String> {
        let Some(held) = self.get(cluster) else { return Ok(false) };
        self.set_bound(cluster, &held.user, &held.password, destination, by, now).map(|_| true)
    }

    /// Move an entry to another name (a cluster renamed), keeping its binding. The secret is
    /// sealed again: the name is its associated data.
    pub fn rename(&self, from: &str, to: &str) -> Result<bool, String> {
        let Some(held) = self.get(from) else { return Ok(false) };
        let (by, bound) = {
            let st = self.stored.read();
            let e = st.clusters.get(from).cloned().unwrap_or_default();
            (e.set_by, e.bound)
        };
        let at = self.stored.read().clusters.get(from).map(|e| e.set_at).unwrap_or(0);
        self.set_bound(to, &held.user, &held.password, &bound, &by, at)?;
        self.remove(from)
    }

    /// Forget one entry. Returns whether there was one.
    pub fn remove(&self, cluster: &str) -> Result<bool, String> {
        if let Some(p) = self.problem.read().clone() {
            return Err(p);
        }
        let mut st = self.stored.write();
        if st.clusters.remove(cluster).is_none() {
            return Ok(false);
        }
        if let Some(p) = &self.path {
            let bytes = serde_json::to_vec_pretty(&*st).map_err(|e| e.to_string())?;
            write_private(p, &bytes).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
        }
        Ok(true)
    }

    /// Every entry, by name, without its secret.
    pub fn list(&self) -> Vec<Listed> {
        self.stored.read().clusters.iter().map(|(name, e)| Listed {
            name: name.clone(),
            user: if e.user == HEADER_USER { None } else { Some(e.user.clone()) },
            set_by: e.set_by.clone(),
            set_at: e.set_at,
            bound: e.bound.clone(),
        }).collect()
    }

    /// Whether a secret of the core's own (the mail server's password, `report::mail`) can be
    /// kept sealed under this key: only where the store has a file and a working key. The
    /// desktop editions keep the store in memory under a key that dies with the process, so
    /// a password sealed there would not open after a restart — refused, with the reason.
    pub fn can_seal_own(&self) -> Result<(), String> {
        if self.path.is_none() {
            return Err("this edition keeps no key for secrets at rest (the hosted server does), so a password cannot be stored here; use a mail server without authentication".into());
        }
        match self.problem() {
            Some(p) => Err(p),
            None => Ok(()),
        }
    }

    /// Seal one of the core's own secrets under this store's key, `aad` bound in.
    pub fn seal_own(&self, aad: &str, plain: &str) -> Result<String, String> {
        self.can_seal_own()?;
        if plain.is_empty() || plain.len() > MAX_PASSWORD {
            return Err(format!("the password must be 1–{MAX_PASSWORD} bytes"));
        }
        crate::crypto::seal_with_key(plain, &self.key, aad)
    }

    /// The inverse of `seal_own`; `None` when it does not open (another key, another `aad`).
    pub fn open_own(&self, aad: &str, sealed: &str) -> Option<String> {
        crate::crypto::open_with_key(sealed, &self.key, aad).ok()
    }

    /// Why nothing can be kept (a configured key that is too short, a key file that could not be
    /// written), or `None` when the store works.
    pub fn problem(&self) -> Option<String> {
        self.problem.read().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ep-cs-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn kept_encrypted_and_read_back_after_a_restart() {
        let d = dir();
        let key = "k".repeat(40);
        let s = ClusterSecrets::open_with(Some(&d), Some(&key));
        s.set("prod-es", "elastic", "hunter2", "alice", 100).unwrap();
        let raw = std::fs::read_to_string(d.join(FILE)).unwrap();
        assert!(!raw.contains("hunter2"), "never in plain text on disk");
        assert!(raw.contains("prod-es") && raw.contains("alice"));
        let again = ClusterSecrets::open_with(Some(&d), Some(&key));
        assert_eq!(again.get("prod-es"), Some(Held { user: "elastic".into(), password: "hunter2".into() }));
        assert_eq!(again.status("prod-es"), Some(("alice".into(), 100)));
        let wrong = ClusterSecrets::open_with(Some(&d), Some(&"x".repeat(40)));
        assert_eq!(wrong.get("prod-es"), None, "another key opens nothing");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn config_clusters_keep_passwords_and_headers_and_can_forget_them() {
        let d = dir();
        let s = ClusterSecrets::open_with(Some(&d), Some(&"k".repeat(40)));
        s.set(&config_key("alpha"), "elastic", "pw", "admin", 5).unwrap();
        s.set_header(&config_key("beta"), "ApiKey abc==", "admin", 6).unwrap();
        s.set(DEFAULT, "ops", "default-pw", "admin", 7).unwrap();
        assert_eq!(s.header_for(&config_key("alpha")).as_deref(), Some("Basic ZWxhc3RpYzpwdw=="));
        assert_eq!(s.header_for(&config_key("beta")).as_deref(), Some("ApiKey abc=="));
        assert_eq!(s.header_for(&config_key("gamma")), None, "no fallback inside header_for");
        let raw = std::fs::read_to_string(d.join(FILE)).unwrap();
        assert!(!raw.contains("ApiKey abc") && !raw.contains("default-pw"), "headers are sealed like passwords");
        let listed = s.list();
        assert_eq!(listed.iter().find(|l| l.name == "cfg:beta").unwrap().user, None, "a header entry lists no username");
        assert_eq!(listed.iter().find(|l| l.name == "cfg:alpha").unwrap().user.as_deref(), Some("elastic"));
        assert!(s.set_header("cfg:x", "  ", "a", 1).is_err());
        assert_eq!(s.remove(&config_key("alpha")), Ok(true));
        assert_eq!(s.remove(&config_key("alpha")), Ok(false));
        let again = ClusterSecrets::open_with(Some(&d), Some(&"k".repeat(40)));
        assert_eq!(again.header_for(&config_key("alpha")), None, "the removal was written");
        assert_eq!(again.header_for(&config_key("beta")).as_deref(), Some("ApiKey abc=="));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn a_bound_entry_goes_to_its_destination_only_and_moves_with_a_rename() {
        let d = dir();
        let s = ClusterSecrets::open_with(Some(&d), Some(&"k".repeat(40)));
        s.set_bound("cfg:a", "u", "p", "https://a:9200||auto", "admin", 1).unwrap();
        assert!(s.header_at("cfg:a", "https://a:9200||auto").is_some());
        assert_eq!(s.header_at("cfg:a", "https://evil:9200||auto"), None, "not to another address");
        s.set(DEFAULT, "d", "dp", "admin", 1).unwrap();
        assert!(s.header_at(DEFAULT, "anywhere").is_some(), "the default is not bound");
        assert_eq!(s.rename("cfg:a", "cfg:b"), Ok(true));
        assert_eq!(s.header_for("cfg:a"), None);
        assert_eq!(s.bound_of("cfg:b").as_deref(), Some("https://a:9200||auto"), "the binding moved with it");
        assert_eq!(s.rebind("cfg:b", "https://a2:9200||auto", "admin", 2), Ok(true));
        assert!(s.header_at("cfg:b", "https://a2:9200||auto").is_some());
        let again = ClusterSecrets::open_with(Some(&d), Some(&"k".repeat(40)));
        assert_eq!(again.header_at("cfg:b", "https://a:9200||auto"), None, "the binding is kept on disk");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn without_a_configured_key_one_is_made_beside_it_once() {
        let d = dir();
        let s = ClusterSecrets::open_with(Some(&d), None);
        s.set("*", "elastic", "def", "bob", 1).unwrap();
        assert!(d.join(KEY_FILE).exists());
        assert_eq!(ClusterSecrets::open_with(Some(&d), None).get("*").map(|h| h.password), Some("def".into()));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn an_override_is_the_host_s_own_and_the_rest_take_the_default() {
        let s = ClusterSecrets::in_memory();
        s.set("*", "svc", "default-pw", "a", 1).unwrap();
        s.set("prod-es", "elastic", "own-pw", "a", 1).unwrap();
        assert_eq!(s.for_cluster("prod-es", true).unwrap().password, "own-pw");
        assert_eq!(s.for_cluster("other-es", false).unwrap().password, "default-pw");
        assert_eq!(s.for_cluster("other-es", true), None, "an override the core was never given is not replaced by the default");
    }

    #[test]
    fn a_short_key_is_refused_and_nothing_is_kept() {
        let d = dir();
        let s = ClusterSecrets::open_with(Some(&d), Some("short"));
        assert!(s.set("prod-es", "e", "p", "a", 1).is_err());
        assert!(!d.join(FILE).exists());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn bad_names_and_sizes_are_refused_and_debug_hides_the_password() {
        let s = ClusterSecrets::in_memory();
        assert!(s.set("", "e", "p", "a", 1).is_err());
        assert!(s.set("a\nb", "e", "p", "a", 1).is_err());
        assert!(s.set("ok", "e", "", "a", 1).is_err());
        assert!(s.set("ok", "e", &"p".repeat(MAX_PASSWORD + 1), "a", 1).is_err());
        let h = Held { user: "u".into(), password: "secret!".into() };
        assert!(!format!("{h:?}").contains("secret!"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_0600_from_the_moment_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        // A permissive umask would have made the old write-then-chmod readable in between.
        let tmp = temp_name(&d.join(FILE));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let f = opts.open(&tmp).unwrap();
        assert_eq!(f.metadata().unwrap().permissions().mode() & 0o777, 0o600, "0600 before anything is written");
        drop(f);
        std::fs::remove_file(&tmp).unwrap();
        write_private(&d.join(FILE), b"x").unwrap();
        assert_eq!(std::fs::metadata(d.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_dir(&d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "no temp file left behind");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn two_writers_never_share_a_temp_name() {
        let d = dir();
        let target = d.join(FILE);
        let names: std::collections::HashSet<PathBuf> = (0..64).map(|_| temp_name(&target)).collect();
        assert_eq!(names.len(), 64);
        let handles: Vec<_> = (0..8).map(|i| {
            let t = target.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    write_private(&t, format!("writer {i}").as_bytes()).unwrap();
                }
            })
        }).collect();
        for h in handles {
            h.join().expect("a writer collided");
        }
        assert!(std::fs::read_to_string(&target).unwrap().starts_with("writer "));
        assert!(std::fs::read_dir(&d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn own_secrets_need_a_kept_key() {
        let mem = ClusterSecrets::in_memory();
        assert!(mem.seal_own("mail.json:password", "pw").unwrap_err().contains("cannot be stored"), "desktop: refused, with the reason");
        let d = dir();
        let s = ClusterSecrets::open_with(Some(&d), Some(&"k".repeat(40)));
        let sealed = s.seal_own("mail.json:password", "hunter2").unwrap();
        assert!(!sealed.contains("hunter2"));
        let again = ClusterSecrets::open_with(Some(&d), Some(&"k".repeat(40)));
        assert_eq!(again.open_own("mail.json:password", &sealed).as_deref(), Some("hunter2"), "opens after a restart");
        assert_eq!(again.open_own("other", &sealed), None, "bound to its name");
        assert!(ClusterSecrets::open_with(Some(&d), Some("short")).seal_own("a", "b").is_err(), "a broken key keeps nothing");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn key_text_hex_or_long_string() {
        assert_eq!(key_from(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(key_from(&"z".repeat(32)).is_ok());
        assert!(key_from("too short").is_err());
    }
}
