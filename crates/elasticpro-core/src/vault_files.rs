//! Files the operator uploads through the UI: jump-host private keys, and the previous
//! versions of the config.
//!
//! Both exist because of the hosted deployment. On the desktop the file browser is the
//! right answer — the key is already on the machine the core runs on, and picking it
//! changes nothing about where it lives. Hosted is different: the key is on the
//! operator's laptop and the core is on a server, so "Browse…" can only ever offer paths
//! on the server, which is not where the file is. Uploading is the only honest way to do
//! it, and `./ssh` is mounted read-only precisely so an upload cannot land there.
//!
//! So an uploaded key goes to the data directory, at 0600, and never comes back out: the
//! UI is told the path and the fingerprint, never the bytes. A private key that can be
//! read back through the same API it was written by is a private key with an extra copy
//! in every browser that asks.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// How many past versions of the config to keep. Enough to undo a bad afternoon, bounded
/// so a busy editor cannot fill the disk with copies of a file full of credentials.
pub const HISTORY_KEEP: usize = 20;

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A name safe to join onto a directory.
///
/// Rejects rather than sanitises where it matters: a name that needed rewriting to be
/// safe is a name the caller got wrong, and quietly storing `id_rsa` when they asked for
/// `../../id_rsa` would hide that.
pub fn safe_name(raw: &str) -> Result<String, String> {
    let base = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    if base.is_empty() || base == "." || base == ".." {
        return Err("that is not a file name".into());
    }
    if base.len() > 128 {
        return Err("the file name is too long".into());
    }
    if !base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err("the file name may use letters, digits, dot, underscore and hyphen only".into());
    }
    Ok(base.to_string())
}

/* ----------------------------------- ssh keys ----------------------------------- */

#[derive(Serialize, Debug)]
pub struct KeyInfo {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub uploaded_at: u64,
    /// SHA-256 of the key file, hex, first 16 chars. Enough to tell two keys apart and
    /// to confirm the right one was uploaded, without being the key.
    pub digest: String,
}

pub struct KeyStore {
    dir: Option<PathBuf>,
}

impl KeyStore {
    pub fn new(data_dir: Option<&Path>) -> KeyStore {
        KeyStore { dir: data_dir.map(|d| d.join("keys")) }
    }

    fn dir(&self) -> Result<&PathBuf, String> {
        self.dir.as_ref().ok_or_else(|| {
            "this core has no data directory, so there is nowhere to keep an uploaded key".into()
        })
    }

    /// Store a key. Returns the path the core will read it from.
    pub fn put(&self, name: &str, text: &str) -> Result<KeyInfo, String> {
        let dir = self.dir()?;
        let name = safe_name(name)?;

        // Checked because the failure otherwise arrives much later and looks like a
        // network problem: the tunnel refuses to open and the error is about SSH, not
        // about the wrong file having been uploaded.
        let head = text.trim_start();
        if !head.starts_with("-----BEGIN ") || !head.contains("PRIVATE KEY-----") {
            return Err("that does not look like an OpenSSH private key — it should begin \
                        with -----BEGIN OPENSSH PRIVATE KEY----- . A .pub file is the \
                        public half and will not work."
                .into());
        }
        if head.contains("PUBLIC KEY-----") {
            return Err("that is a public key; the core needs the private half".into());
        }

        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }

        let path = dir.join(&name);
        // Written private from the first byte: create it 0600 rather than write then
        // chmod, so it is never briefly readable by anyone else.
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }

        self.info(&path)
    }

    fn info(&self, path: &Path) -> Result<KeyInfo, String> {
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        Ok(KeyInfo {
            name: path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
            path: path.to_string_lossy().to_string(),
            bytes: meta.len(),
            uploaded_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or_else(now),
            digest: hex::encode(Sha256::digest(&bytes))[..16].to_string(),
        })
    }

    pub fn list(&self) -> Vec<KeyInfo> {
        let Ok(dir) = self.dir() else { return vec![] };
        let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
        let mut out: Vec<KeyInfo> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .filter_map(|e| self.info(&e.path()).ok())
            .collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.uploaded_at));
        out
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        let dir = self.dir()?;
        let name = safe_name(name)?;
        std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())
    }
}

/* --------------------------------- config history -------------------------------- */

#[derive(Serialize, Debug)]
pub struct VersionInfo {
    pub id: String,
    pub saved_at: u64,
    pub bytes: u64,
    /// The file this was a version of, so a history built from more than one path still
    /// says which is which.
    pub source: String,
}

pub struct ConfigHistory {
    dir: Option<PathBuf>,
}

impl ConfigHistory {
    pub fn new(data_dir: Option<&Path>) -> ConfigHistory {
        ConfigHistory { dir: data_dir.map(|d| d.join("config-history")) }
    }

    /// Keep what is currently at `path` before something replaces it.
    ///
    /// Best effort on purpose: a history that cannot be written must never stop a save
    /// the operator asked for. It returns whether it kept anything so the caller can say
    /// so, and nothing more.
    pub fn snapshot(&self, path: &Path) -> bool {
        let Some(dir) = &self.dir else { return false };
        let Ok(text) = std::fs::read_to_string(path) else { return false };
        if text.trim().is_empty() {
            return false;
        }
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let stem = path.file_name().and_then(|s| s.to_str()).unwrap_or("config");
        let id = format!("{}-{}", now(), stem);
        let dest = dir.join(&id);
        if std::fs::write(&dest, &text).is_err() {
            return false;
        }
        // These are copies of a file that holds cluster credentials. Same protection as
        // the original, or the history is the weak point.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
        }
        self.trim();
        true
    }

    fn trim(&self) {
        let Some(dir) = &self.dir else { return };
        let mut all: Vec<PathBuf> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        if all.len() <= HISTORY_KEEP {
            return;
        }
        all.sort();
        for p in all.iter().take(all.len() - HISTORY_KEEP) {
            let _ = std::fs::remove_file(p);
        }
    }

    pub fn list(&self) -> Vec<VersionInfo> {
        let Some(dir) = &self.dir else { return vec![] };
        let mut out: Vec<VersionInfo> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .filter_map(|e| {
                let id = e.file_name().to_str()?.to_string();
                let (ts, source) = id.split_once('-')?;
                Some(VersionInfo {
                    saved_at: ts.parse().ok()?,
                    bytes: e.metadata().ok()?.len(),
                    source: source.to_string(),
                    id,
                })
            })
            .collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.saved_at));
        out
    }

    /// The stored text of one version.
    pub fn read(&self, id: &str) -> Result<String, String> {
        let dir = self.dir.as_ref().ok_or("no data directory")?;
        let id = safe_name(id)?;
        std::fs::read_to_string(dir.join(id)).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("elasticpro-vf-{tag}-{}", now()));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nc29tZQ==\n-----END OPENSSH PRIVATE KEY-----\n";

    #[test]
    fn a_name_cannot_climb_out_of_the_directory() {
        assert!(safe_name("../../etc/shadow").is_ok(), "basename is taken first");
        assert_eq!(safe_name("../../etc/shadow").unwrap(), "shadow");
        assert!(safe_name("..").is_err());
        assert!(safe_name("").is_err());
        assert!(safe_name("a/b").unwrap() == "b");
        assert!(safe_name("we ird").is_err(), "a space is not allowed");
        assert!(safe_name("id_ed25519").is_ok());
    }

    #[test]
    fn a_key_is_stored_private_and_never_read_back() {
        let t = Tmp::new("key");
        let ks = KeyStore::new(Some(&t.0));
        let info = ks.put("id_ed25519", KEY).unwrap();
        assert_eq!(info.name, "id_ed25519");
        assert!(info.digest.len() == 16);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&info.path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "a private key must not be group or world readable");
        }
        // The listing describes it; it does not contain it.
        let listed = serde_json::to_string(&ks.list()).unwrap();
        assert!(!listed.contains("c29tZQ"), "the key material leaked into the listing");

        ks.delete("id_ed25519").unwrap();
        assert!(ks.list().is_empty());
    }

    #[test]
    fn something_that_is_not_a_private_key_is_refused() {
        let t = Tmp::new("notakey");
        let ks = KeyStore::new(Some(&t.0));
        assert!(ks.put("x", "just some text").is_err());
        assert!(ks.put("x", "ssh-ed25519 AAAAC3Nz... me@host").is_err(), "a .pub is not a key");
        let e = ks.put("x", "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----").unwrap_err();
        assert!(e.contains("private"), "{e}");
    }

    #[test]
    fn history_keeps_versions_newest_first_and_can_read_one_back() {
        let t = Tmp::new("hist");
        let h = ConfigHistory::new(Some(&t.0));
        let cfg = t.0.join("config_cluster.json");

        std::fs::write(&cfg, r#"{"v":1}"#).unwrap();
        assert!(h.snapshot(&cfg));
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&cfg, r#"{"v":2}"#).unwrap();
        assert!(h.snapshot(&cfg));

        let list = h.list();
        assert_eq!(list.len(), 2);
        assert!(list[0].saved_at >= list[1].saved_at, "newest first");
        assert_eq!(h.read(&list[0].id).unwrap(), r#"{"v":2}"#);
        assert_eq!(h.read(&list[1].id).unwrap(), r#"{"v":1}"#);
        assert!(list.iter().all(|v| v.source == "config_cluster.json"));
    }

    #[test]
    fn an_empty_or_missing_file_is_not_worth_keeping() {
        let t = Tmp::new("empty");
        let h = ConfigHistory::new(Some(&t.0));
        assert!(!h.snapshot(&t.0.join("nope.json")), "nothing to snapshot");
        let cfg = t.0.join("blank.json");
        std::fs::write(&cfg, "   \n").unwrap();
        assert!(!h.snapshot(&cfg), "an empty file is not a version worth restoring");
        assert!(h.list().is_empty());
    }

    #[test]
    fn history_is_bounded() {
        let t = Tmp::new("trim");
        let h = ConfigHistory::new(Some(&t.0));
        let cfg = t.0.join("c.json");
        // Written directly rather than through snapshot(), which is second-granular.
        let dir = t.0.join("config-history");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..(HISTORY_KEEP + 5) {
            std::fs::write(dir.join(format!("{:010}-c.json", 1_000_000 + i)), "{}").unwrap();
        }
        std::fs::write(&cfg, "{}").unwrap();
        h.snapshot(&cfg);
        assert!(h.list().len() <= HISTORY_KEEP, "history grew to {}", h.list().len());
    }
}
