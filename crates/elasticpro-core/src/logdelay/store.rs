//! The built-in store: what the server keeps itself, whatever else the run writes to
//! (docs/LOGDELAY.md "Where it is kept").
//!
//! ```text
//!   <data>/logdelay.json                       settings (levels, fields, silence limit)
//!   <data>/logdelay/clusters.json              directory name → cluster id
//!   <data>/logdelay/<cluster>/tracker.json     the memory between runs (state.rs)
//!   <data>/logdelay/<cluster>/daily.json       day → totals
//!   <data>/logdelay/<cluster>/m/YYYY-MM-DD.ndjson   one line per device per run
//!   <data>/logdelay/findings.json              the recommended fixes, as last matched
//! ```
//!
//! Every page and every report reads from here. The history store (or a sink cluster) gets
//! the same records as a mirror, under its own gates; the local files are the working copy,
//! as the volume record's month files are. Kept 90 days (`state::KEEP_MS`); the prune runs
//! after every measurement.
//!
//! A tracker is parsed once and kept in memory (`Arc`), replaced when it is written: the
//! pages read it on every call, the run rewrites it every two hours.

use super::state::{Daily, Tracker, KEEP_MS};
use crate::volume::store::write_atomic;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

pub const SETTINGS_FILE: &str = "logdelay.json";
pub const DIR: &str = "logdelay";
const INDEX: &str = "clusters.json";

/// Parsed trackers by file path, process-wide (a test runs many cores on many directories).
fn cache() -> &'static Mutex<HashMap<PathBuf, Arc<Tracker>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<Tracker>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bytes on disk by kind, for Data › Backend and the settings page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sizes {
    pub bytes: u64,
    pub trackers_bytes: u64,
    pub daily_bytes: u64,
    pub day_files_bytes: u64,
    pub day_files: u64,
    pub clusters: u64,
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(data_dir: &Path) -> Store {
        Store { root: data_dir.join(DIR) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir_name(cluster: &str) -> String {
        crate::report::build::file_part(cluster)
    }

    fn cluster_dir(&self, cluster: &str) -> PathBuf {
        self.root.join(Self::dir_name(cluster))
    }

    fn index(&self) -> BTreeMap<String, String> {
        read_json(&self.root.join(INDEX)).unwrap_or_default()
    }

    /// Every cluster id with a tracker on disk, from the index (a directory name is a
    /// file-safe rendering of the id, not the id).
    pub fn clusters(&self) -> Vec<String> {
        let index = self.index();
        let Ok(rd) = std::fs::read_dir(&self.root) else { return vec![] };
        let mut out: Vec<String> = rd.flatten()
            .filter(|e| e.path().join("tracker.json").is_file())
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .map(|dir| index.get(&dir).cloned().unwrap_or(dir))
            .collect();
        out.sort();
        out
    }

    pub fn read_tracker(&self, cluster: &str) -> Arc<Tracker> {
        let path = self.cluster_dir(cluster).join("tracker.json");
        if let Some(t) = cache().lock().get(&path) {
            return t.clone();
        }
        let t: Arc<Tracker> = Arc::new(read_json(&path).unwrap_or_default());
        cache().lock().insert(path, t.clone());
        t
    }

    pub fn write_tracker(&self, cluster: &str, t: &Tracker) -> Result<(), String> {
        let dir = self.cluster_dir(cluster);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("tracker.json");
        write_atomic(&path, &serde_json::to_vec(t).map_err(|e| e.to_string())?)?;
        cache().lock().insert(path, Arc::new(t.clone()));
        let mut index = self.index();
        if index.get(&Self::dir_name(cluster)).map(String::as_str) != Some(cluster) {
            index.insert(Self::dir_name(cluster), cluster.to_string());
            write_atomic(&self.root.join(INDEX), &serde_json::to_vec(&index).map_err(|e| e.to_string())?)?;
        }
        Ok(())
    }

    pub fn read_daily(&self, cluster: &str) -> BTreeMap<String, Daily> {
        read_json(&self.cluster_dir(cluster).join("daily.json")).unwrap_or_default()
    }

    /// Keep one day's totals, dropping days older than the retention.
    pub fn put_daily(&self, cluster: &str, d: &Daily, now_ms: i64) -> Result<(), String> {
        let dir = self.cluster_dir(cluster);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut all = self.read_daily(cluster);
        all.insert(d.day.clone(), d.clone());
        let oldest = oldest_kept_day(now_ms);
        all.retain(|k, _| k.as_str() >= oldest.as_str());
        write_atomic(&dir.join("daily.json"), &serde_json::to_vec(&all).map_err(|e| e.to_string())?)
    }

    /// Append one run's measurement lines to the day's file.
    pub fn append_measurements(&self, cluster: &str, day: &str, lines: &[Value]) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }
        let dir = self.cluster_dir(cluster).join("m");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut body = String::new();
        for l in lines {
            body.push_str(&l.to_string());
            body.push('\n');
        }
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{day}.ndjson"))).map_err(|e| e.to_string())?;
        f.write_all(body.as_bytes()).map_err(|e| e.to_string())
    }

    /// The measurement lines of one device between two days inclusive (`YYYY-MM-DD`), oldest
    /// first. Reads only the day files in range; `None` for a device filter reads every line.
    pub fn read_measurements(&self, cluster: &str, device: Option<&str>, from_day: &str, to_day: &str, max: usize) -> (Vec<Value>, bool) {
        let dir = self.cluster_dir(cluster).join("m");
        let mut days: Vec<String> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd.flatten().filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".ndjson")).map(String::from))
                .filter(|d| d.as_str() >= from_day && d.as_str() <= to_day).collect(),
            Err(_) => return (vec![], false),
        };
        days.sort();
        let needle = device.map(|d| format!("\"device\":{}", serde_json::to_string(d).unwrap_or_default()));
        let mut out = vec![];
        let mut truncated = false;
        'days: for d in days {
            let Ok(text) = std::fs::read_to_string(dir.join(format!("{d}.ndjson"))) else { continue };
            for line in text.lines() {
                if let Some(n) = &needle {
                    if !line.contains(n.as_str()) {
                        continue;
                    }
                }
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if device.is_some_and(|dv| v.get("device").and_then(Value::as_str) != Some(dv)) {
                        continue;
                    }
                    if out.len() >= max {
                        truncated = true;
                        break 'days;
                    }
                    out.push(v);
                }
            }
        }
        (out, truncated)
    }

    /// Delete day files older than the retention, every cluster. Returns how many went.
    pub fn prune(&self, now_ms: i64) -> usize {
        let oldest = oldest_kept_day(now_ms);
        let mut n = 0;
        let Ok(rd) = std::fs::read_dir(&self.root) else { return 0 };
        for c in rd.flatten().filter(|e| e.path().is_dir()) {
            let dir = c.path().join("m");
            let Ok(files) = std::fs::read_dir(&dir) else { continue };
            for e in files.flatten() {
                let keep = e.file_name().to_str().and_then(|s| s.strip_suffix(".ndjson")).is_some_and(|d| d >= oldest.as_str());
                if !keep && std::fs::remove_file(e.path()).is_ok() {
                    n += 1;
                }
            }
        }
        n
    }

    pub fn read_findings(&self) -> Value {
        read_json(&self.root.join("findings.json")).unwrap_or(Value::Null)
    }

    pub fn write_findings(&self, v: &Value) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        write_atomic(&self.root.join("findings.json"), &serde_json::to_vec(v).map_err(|e| e.to_string())?)
    }

    /// Bytes on disk under the store, by kind.
    pub fn sizes(&self) -> Sizes {
        let mut s = Sizes::default();
        let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let Ok(rd) = std::fs::read_dir(&self.root) else { return s };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                s.bytes += size(&p);
                continue;
            }
            s.clusters += 1;
            s.trackers_bytes += size(&p.join("tracker.json"));
            s.daily_bytes += size(&p.join("daily.json"));
            if let Ok(files) = std::fs::read_dir(p.join("m")) {
                for f in files.flatten() {
                    s.day_files += 1;
                    s.day_files_bytes += size(&f.path());
                }
            }
        }
        s.bytes += s.trackers_bytes + s.daily_bytes + s.day_files_bytes;
        s
    }

    /// Bytes on disk under the store.
    pub fn size_bytes(&self) -> u64 {
        self.sizes().bytes
    }
}

/// The oldest local day the store keeps, as a key.
pub fn oldest_kept_day(now_ms: i64) -> String {
    super::time::local_day_key(now_ms - KEEP_MS)
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Option<T> {
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("elasticpro-logdelay-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn day_files_are_appended_read_by_device_and_pruned() {
        let dir = tmp("store");
        let s = Store::new(&dir);
        s.write_tracker("prod", &Tracker::default()).unwrap();
        s.append_measurements("prod", "2026-11-04", &[json!({ "device": "fw-1", "delay_minutes": 41 }), json!({ "device": "fw-2", "delay_minutes": 1 })]).unwrap();
        s.append_measurements("prod", "2026-11-05", &[json!({ "device": "fw-1", "delay_minutes": 5 })]).unwrap();
        s.append_measurements("prod", "2020-01-01", &[json!({ "device": "fw-1", "delay_minutes": 5 })]).unwrap();
        let (rows, truncated) = s.read_measurements("prod", Some("fw-1"), "2026-11-01", "2026-11-30", 100);
        assert_eq!(rows.len(), 2);
        assert!(!truncated);
        assert_eq!(rows[0]["delay_minutes"], 41);
        let (all, _) = s.read_measurements("prod", None, "2026-11-04", "2026-11-04", 100);
        assert_eq!(all.len(), 2);
        let (capped, truncated) = s.read_measurements("prod", None, "2000-01-01", "2030-01-01", 2);
        assert_eq!((capped.len(), truncated), (2, true));
        assert_eq!(s.clusters(), vec!["prod".to_string()]);
        let sizes = s.sizes();
        assert_eq!((sizes.clusters, sizes.day_files), (1, 3));
        assert!(sizes.day_files_bytes > 0 && sizes.trackers_bytes > 0 && sizes.bytes >= sizes.day_files_bytes + sizes.trackers_bytes);
        // The 2020 file is older than 90 days: pruned; the November ones stay.
        let now = crate::delay_sink::parse_rfc3339_ms("2026-11-07T10:00:00Z").unwrap();
        assert_eq!(s.prune(now), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cluster_id_that_is_not_a_file_name_comes_back_as_itself_and_the_cache_follows_writes() {
        let dir = tmp("index");
        let s = Store::new(&dir);
        let id = "Client A/prod (EU)";
        s.write_tracker(id, &Tracker::default()).unwrap();
        assert_eq!(s.clusters(), vec![id.to_string()], "the directory name is not the id");
        let first = s.read_tracker(id);
        assert!(first.devices.is_empty());
        let t = Tracker { last_run_ms: Some(42), ..Default::default() };
        s.write_tracker(id, &t).unwrap();
        assert_eq!(s.read_tracker(id).last_run_ms, Some(42), "a write replaces the cached copy");
        assert!(Arc::ptr_eq(&s.read_tracker(id), &s.read_tracker(id)), "reads share one parsed copy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn daily_totals_keep_ninety_days() {
        let dir = tmp("daily");
        let s = Store::new(&dir);
        let now = crate::delay_sink::parse_rfc3339_ms("2026-11-07T10:00:00Z").unwrap();
        s.put_daily("prod", &Daily { day: "2026-05-01".into(), ..Daily::default() }, now).unwrap();
        s.put_daily("prod", &Daily { day: "2026-11-06".into(), devices: 3, ..Daily::default() }, now).unwrap();
        let all = s.read_daily("prod");
        assert_eq!(all.keys().cloned().collect::<Vec<_>>(), vec!["2026-11-06".to_string()]);
        assert_eq!(all["2026-11-06"].devices, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
