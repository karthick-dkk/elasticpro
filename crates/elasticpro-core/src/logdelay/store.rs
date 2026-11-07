//! The built-in store: what the server keeps itself, whatever else the run writes to
//! (docs/LOGDELAY.md "Where it is kept").
//!
//! ```text
//!   <data>/logdelay.json                       settings (levels, fields, silence limit)
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

use super::state::{Daily, Tracker, KEEP_MS};
use crate::volume::store::write_atomic;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE: &str = "logdelay.json";
pub const DIR: &str = "logdelay";

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

    fn cluster_dir(&self, cluster: &str) -> PathBuf {
        self.root.join(crate::report::build::file_part(cluster))
    }

    /// Every cluster with a tracker on disk.
    pub fn clusters(&self) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(&self.root) else { return vec![] };
        let mut out: Vec<String> = rd.flatten()
            .filter(|e| e.path().join("tracker.json").is_file())
            .filter_map(|e| e.file_name().to_str().map(String::from)).collect();
        out.sort();
        out
    }

    pub fn read_tracker(&self, cluster: &str) -> Tracker {
        read_json(&self.cluster_dir(cluster).join("tracker.json")).unwrap_or_default()
    }

    pub fn write_tracker(&self, cluster: &str, t: &Tracker) -> Result<(), String> {
        let dir = self.cluster_dir(cluster);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_atomic(&dir.join("tracker.json"), &serde_json::to_vec(t).map_err(|e| e.to_string())?)
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
        for c in self.clusters() {
            let dir = self.root.join(&c).join("m");
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
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

    /// Bytes on disk under the store, for Data › Backend.
    pub fn size_bytes(&self) -> u64 {
        fn walk(p: &Path) -> u64 {
            let Ok(rd) = std::fs::read_dir(p) else { return 0 };
            rd.flatten().map(|e| {
                let path = e.path();
                if path.is_dir() { walk(&path) } else { std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) }
            }).sum()
        }
        walk(&self.root)
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
        // The 2020 file is older than 90 days: pruned; the November ones stay.
        let now = crate::delay_sink::parse_rfc3339_ms("2026-11-07T10:00:00Z").unwrap();
        assert_eq!(s.prune(now), 1);
        assert!(s.size_bytes() > 0);
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
