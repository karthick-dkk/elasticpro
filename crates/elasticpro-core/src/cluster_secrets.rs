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

#[derive(Serialize, Deserialize, Clone, Default)]
struct Entry {
    user: String,
    /// `crypto::seal_with_key`, the cluster name as associated data.
    sealed: String,
    set_by: String,
    set_at: u64,
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
        st.clusters.insert(cluster.to_string(), Entry { user: user.trim().to_string(), sealed, set_by: by.to_string(), set_at: now });
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
    fn key_text_hex_or_long_string() {
        assert_eq!(key_from(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(key_from(&"z".repeat(32)).is_ok());
        assert!(key_from("too short").is_err());
    }
}
