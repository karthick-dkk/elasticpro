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

use serde::{Deserialize, Serialize};
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
    /// When this version was first written — the save that produced it, when that is known
    /// (`saved_by` is set); else when it was set aside for the save that replaced it.
    pub saved_at: u64,
    pub bytes: u64,
    /// The file this was a version of, so a history built from more than one path still
    /// says which is which.
    pub source: String,
    /// Who saved this version: an account name, or `system`/`local` when the core wrote it
    /// without a person. `None` for a version kept before this was recorded — the UI shows
    /// "—", not a guess.
    pub saved_by: Option<String>,
    /// What this version changed against the one before it (`config_diff::summarize`),
    /// computed by the core when it was saved. `None` when not recorded.
    pub summary: Option<String>,
}

/// The live file's own record: who saved what is on disk now, and what that save changed.
/// The same facts the versions carry, for the row the UI marks "current".
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CurrentInfo {
    pub saved_at: u64,
    pub saved_by: String,
    pub summary: String,
    pub source: String,
}

/// The sidecar kept next to a version (`<id>.meta.json`), and, as `current-<stem>.meta.json`,
/// next to nothing: the record of the save that produced the live file. Private shape.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct SaveMeta {
    saved_at: u64,
    saved_by: String,
    summary: String,
}

/// What `keep_before` did and what `record` will write once the caller's write succeeded.
#[derive(Debug)]
pub struct PendingSave {
    /// A version of the previous content was set aside.
    pub kept: bool,
    current_name: String,
    meta: Option<SaveMeta>,
}

const META_SUFFIX: &str = ".meta.json";
const CURRENT_PREFIX: &str = "current-";

pub struct ConfigHistory {
    dir: Option<PathBuf>,
}

impl ConfigHistory {
    pub fn new(data_dir: Option<&Path>) -> ConfigHistory {
        ConfigHistory { dir: data_dir.map(|d| d.join("config-history")) }
    }

    fn stem_of(path: &Path) -> &str {
        path.file_name().and_then(|s| s.to_str()).unwrap_or("config")
    }

    fn write_private(dest: &Path, text: &str) -> bool {
        if std::fs::write(dest, text).is_err() {
            return false;
        }
        // These are copies of a file that holds cluster credentials. Same protection as
        // the original, or the history is the weak point.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o600));
        }
        true
    }

    fn read_meta(&self, name: &str) -> Option<SaveMeta> {
        let dir = self.dir.as_ref()?;
        serde_json::from_str(&std::fs::read_to_string(dir.join(name)).ok()?).ok()
    }

    /// Keep what is currently at `path` before something replaces it, and prepare the record
    /// of who is replacing it with `new_text` and what that changes. The record itself is
    /// written by `record`, once the caller's write has succeeded — a save that fails must
    /// not leave a "current" record describing a file that is not there.
    ///
    /// Best effort on purpose: a history that cannot be written must never stop a save
    /// the operator asked for. `kept` says whether a version was set aside, nothing more.
    ///
    /// The version set aside is the content the *previous* save produced, so the record of
    /// that save (kept as `current-<stem>.meta.json` since then) is copied to it. A version
    /// from before these records existed simply has none.
    pub fn keep_before(&self, path: &Path, new_text: &str, by: &str) -> PendingSave {
        let stem = Self::stem_of(path);
        let current_name = format!("{CURRENT_PREFIX}{stem}{META_SUFFIX}");
        let mut pending = PendingSave { kept: false, current_name, meta: None };
        let Some(dir) = &self.dir else { return pending };
        if std::fs::create_dir_all(dir).is_err() {
            return pending;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let old_text = std::fs::read_to_string(path).unwrap_or_default();
        if !old_text.trim().is_empty() {
            let id = format!("{}-{}", now(), stem);
            if Self::write_private(&dir.join(&id), &old_text) {
                if let Some(prev) = self.read_meta(&pending.current_name) {
                    if let Ok(s) = serde_json::to_string(&prev) {
                        Self::write_private(&dir.join(format!("{id}{META_SUFFIX}")), &s);
                    }
                }
                pending.kept = true;
            }
        }
        pending.meta = Some(SaveMeta {
            saved_at: now(),
            saved_by: by.trim().to_string(),
            summary: crate::config_diff::summarize_text(&old_text, new_text),
        });
        self.trim();
        pending
    }

    /// Write the record `keep_before` prepared, now that the file it describes is on disk.
    pub fn record(&self, pending: &PendingSave) {
        let (Some(dir), Some(meta)) = (&self.dir, &pending.meta) else { return };
        if let Ok(s) = serde_json::to_string(meta) {
            Self::write_private(&dir.join(&pending.current_name), &s);
        }
    }

    /// `keep_before` and `record` in one step, for a caller whose write cannot fail in
    /// between (tests; a history whose file is written by somebody else).
    pub fn keep(&self, path: &Path, new_text: &str, by: &str) -> bool {
        let p = self.keep_before(path, new_text, by);
        self.record(&p);
        p.kept
    }

    /// Whether a directory entry is a version (not a sidecar, not the current record).
    fn is_version_name(name: &str) -> bool {
        !name.ends_with(META_SUFFIX) && !name.starts_with(CURRENT_PREFIX) && !name.starts_with('.')
    }

    fn trim(&self) {
        let Some(dir) = &self.dir else { return };
        let mut all: Vec<PathBuf> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(Self::is_version_name))
            .collect();
        if all.len() <= HISTORY_KEEP {
            return;
        }
        all.sort();
        for p in all.iter().take(all.len() - HISTORY_KEEP) {
            let _ = std::fs::remove_file(p);
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                let _ = std::fs::remove_file(dir.join(format!("{name}{META_SUFFIX}")));
            }
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
                if !Self::is_version_name(&id) {
                    return None;
                }
                let (ts, source) = id.split_once('-')?;
                let meta = self.read_meta(&format!("{id}{META_SUFFIX}"));
                Some(VersionInfo {
                    // The save that produced this content, when recorded; else when it was set aside.
                    saved_at: meta.as_ref().map(|m| m.saved_at).unwrap_or(ts.parse().ok()?),
                    bytes: e.metadata().ok()?.len(),
                    source: source.to_string(),
                    saved_by: meta.as_ref().map(|m| m.saved_by.clone()),
                    summary: meta.map(|m| m.summary),
                    id,
                })
            })
            .collect();
        // Newest first; the id (set-aside time, then name) breaks ties within one second.
        out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then_with(|| b.id.cmp(&a.id)));
        out
    }

    /// The record of the save that produced the live file at `path`, when one was made.
    pub fn current(&self, path: &Path) -> Option<CurrentInfo> {
        let stem = Self::stem_of(path);
        let m = self.read_meta(&format!("{CURRENT_PREFIX}{stem}{META_SUFFIX}"))?;
        Some(CurrentInfo { saved_at: m.saved_at, saved_by: m.saved_by, summary: m.summary, source: stem.to_string() })
    }

    /// Every current record there is, whatever the file: for a CONFIG_HISTORY that does not
    /// name a path. Newest first.
    pub fn currents(&self) -> Vec<CurrentInfo> {
        let Some(dir) = &self.dir else { return vec![] };
        let mut out: Vec<CurrentInfo> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let stem = name.strip_prefix(CURRENT_PREFIX)?.strip_suffix(META_SUFFIX)?;
                let m = self.read_meta(&name)?;
                Some(CurrentInfo { saved_at: m.saved_at, saved_by: m.saved_by, summary: m.summary, source: stem.to_string() })
            })
            .collect();
        out.sort_by_key(|c| std::cmp::Reverse(c.saved_at));
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

        // Nothing on disk yet: no version, but the save is recorded as the current one.
        assert!(!h.keep(&cfg, r#"{"v":1}"#, "ann"));
        std::fs::write(&cfg, r#"{"v":1}"#).unwrap();
        let cur = h.current(&cfg).unwrap();
        assert_eq!((cur.saved_by.as_str(), cur.summary.as_str()), ("ann", "v added"));

        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(h.keep(&cfg, r#"{"v":2}"#, "bob"));
        std::fs::write(&cfg, r#"{"v":2}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(h.keep(&cfg, r#"{"v":3}"#, "ann"));
        std::fs::write(&cfg, r#"{"v":3}"#).unwrap();

        let list = h.list();
        assert_eq!(list.len(), 2);
        assert!(list[0].saved_at >= list[1].saved_at, "newest first");
        assert_eq!(h.read(&list[0].id).unwrap(), r#"{"v":2}"#);
        assert_eq!(h.read(&list[1].id).unwrap(), r#"{"v":1}"#);
        assert!(list.iter().all(|v| v.source == "config_cluster.json"));
        // Each version carries the record of the save that produced it.
        assert_eq!((list[0].saved_by.as_deref(), list[0].summary.as_deref()), (Some("bob"), Some("v 1 → 2")));
        assert_eq!((list[1].saved_by.as_deref(), list[1].summary.as_deref()), (Some("ann"), Some("v added")));
        let cur = h.current(&cfg).unwrap();
        assert_eq!((cur.saved_by.as_str(), cur.summary.as_str()), ("ann", "v 2 → 3"));
        assert_eq!(h.currents().len(), 1);
    }

    #[test]
    fn a_failed_write_leaves_no_record_of_it() {
        let t = Tmp::new("pending");
        let h = ConfigHistory::new(Some(&t.0));
        let cfg = t.0.join("c.json");
        std::fs::write(&cfg, r#"{"v":1}"#).unwrap();
        assert!(h.keep(&cfg, r#"{"v":1}"#, "ann"));
        let before = h.current(&cfg).unwrap();
        // The write that follows keep_before fails: record() is never called.
        let p = h.keep_before(&cfg, r#"{"v":2}"#, "bob");
        assert!(p.kept);
        assert_eq!(h.current(&cfg).unwrap(), before, "the live file is still v1, and its record says so");
        // The version set aside keeps its own record, copied, not moved.
        let newest = &h.list()[0];
        assert_eq!(newest.saved_by.as_deref(), Some("ann"));
        // Then a write that succeeds records.
        h.record(&p);
        assert_eq!(h.current(&cfg).unwrap().saved_by, "bob");
        assert_eq!(h.current(&cfg).unwrap().summary, "v 1 → 2");
    }

    #[test]
    fn a_version_from_before_the_records_has_none() {
        let t = Tmp::new("old");
        let h = ConfigHistory::new(Some(&t.0));
        let dir = t.0.join("config-history");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1700000000-c.json"), r#"{"v":0}"#).unwrap();
        let list = h.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].saved_at, 1_700_000_000);
        assert!(list[0].saved_by.is_none() && list[0].summary.is_none(), "unknown, not invented");
        assert!(h.current(&t.0.join("c.json")).is_none());
    }

    #[test]
    fn no_secret_reaches_a_record() {
        let t = Tmp::new("secret");
        let h = ConfigHistory::new(Some(&t.0));
        let cfg = t.0.join("c.json");
        std::fs::write(&cfg, r#"{"credentials":{"username":"e","password":"old-pw"}}"#).unwrap();
        h.keep(&cfg, r#"{"credentials":{"username":"e","password":"new-pw"}}"#, "ann");
        let cur = h.current(&cfg).unwrap();
        assert_eq!(cur.summary, "Credentials · credential changed");
        for f in std::fs::read_dir(t.0.join("config-history")).unwrap() {
            let p = f.unwrap().path();
            if p.to_string_lossy().ends_with(".meta.json") {
                let s = std::fs::read_to_string(&p).unwrap();
                assert!(!s.contains("old-pw") && !s.contains("new-pw"), "{s}");
            }
        }
    }

    #[test]
    fn an_empty_or_missing_file_is_not_worth_keeping() {
        let t = Tmp::new("empty");
        let h = ConfigHistory::new(Some(&t.0));
        assert!(!h.keep(&t.0.join("nope.json"), "{}", "x"), "nothing to snapshot");
        let cfg = t.0.join("blank.json");
        std::fs::write(&cfg, "   \n").unwrap();
        assert!(!h.keep(&cfg, "{}", "x"), "an empty file is not a version worth restoring");
        assert!(h.list().is_empty());
    }

    #[test]
    fn history_is_bounded_and_sidecars_go_with_their_versions() {
        let t = Tmp::new("trim");
        let h = ConfigHistory::new(Some(&t.0));
        let cfg = t.0.join("c.json");
        // Written directly rather than through keep(), which is second-granular.
        let dir = t.0.join("config-history");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..(HISTORY_KEEP + 5) {
            std::fs::write(dir.join(format!("{:010}-c.json", 1_000_000 + i)), "{}").unwrap();
            std::fs::write(dir.join(format!("{:010}-c.json.meta.json", 1_000_000 + i)),
                           r#"{"saved_at":1,"saved_by":"x","summary":"s"}"#).unwrap();
        }
        std::fs::write(&cfg, "{}").unwrap();
        h.keep(&cfg, "{}", "x");
        assert!(h.list().len() <= HISTORY_KEEP, "history grew to {}", h.list().len());
        let metas = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".meta.json")).count();
        // One sidecar per kept version at most, plus the current record.
        assert!(metas <= HISTORY_KEEP + 1, "{metas} sidecars left");
        assert!(!dir.join("0001000000-c.json.meta.json").exists(), "the oldest sidecar went with its version");
    }
}
