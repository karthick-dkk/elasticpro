//! The shared measurement cache (docs/PLAY.md "Shared measurement cache"): a measurement one
//! page made, kept so the next page — another TV, another person — reads it instead of
//! asking the cluster again. N walls measure the log delay once.
//!
//! Two kinds: `delay` (the Logs page's device-delay measurement) and `repoSize` (a snapshot
//! repository's size, from the Volume page or the scraper). One record per kind and cluster —
//! the newest by `measuredAt`; an older one offered later is not kept. On disk, one small file
//! each under `<data>/play/share/<kind>/`, read when asked for, so the core holds none of it
//! in memory; kept 48 h. Without a data directory (the desktop app before a config is chosen)
//! they are kept in memory instead.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub const DIR: &str = "share";
pub const KINDS: &[&str] = &["delay", "repoSize"];
/// How long a measurement is offered.
pub const KEEP_MS: u64 = 48 * 3600 * 1000;
/// Device records in one delay measurement, at most.
pub const MAX_DELAY_RECORDS: usize = 2000;
/// A measurement's data, serialised, at most: delay / repoSize.
pub const MAX_DELAY_BYTES: usize = 1024 * 1024;
pub const MAX_REPO_BYTES: usize = 64 * 1024;
/// A measurement claiming to be from the future by more than this is refused.
const CLOCK_SKEW_MS: u64 = 5 * 60_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub cluster_id: String,
    pub measured_at: u64,
    pub put_at: u64,
    pub by: String,
    pub data: Value,
}

pub struct Share {
    dir: Option<PathBuf>,
    mem: Mutex<HashMap<(String, String), Record>>,
    /// One writer at a time, so "newest wins" is decided against what is on disk.
    writing: Mutex<()>,
}

pub fn check_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("kind: one of {}", KINDS.join(", ")))
    }
}

/// The records in a delay measurement: the data itself when it is a list, else its
/// `devices` list.
fn delay_records(data: &Value) -> Option<usize> {
    match data {
        Value::Array(a) => Some(a.len()),
        Value::Object(m) => m.get("devices").and_then(Value::as_array).map(Vec::len),
        _ => None,
    }
}

impl Share {
    pub fn open(dir: Option<PathBuf>) -> Share {
        Share { dir, mem: Default::default(), writing: Default::default() }
    }

    fn file(&self, kind: &str, cluster: &str) -> Option<PathBuf> {
        // Hex: a cluster id may hold any character, a file name may not.
        self.dir.as_ref().map(|d| d.join(kind).join(format!("{}.json", hex::encode(cluster.as_bytes()))))
    }

    fn read(&self, kind: &str, cluster: &str) -> Option<Record> {
        match self.file(kind, cluster) {
            Some(p) => std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Record>(&b).ok()),
            None => self.mem.lock().get(&(kind.to_string(), cluster.to_string())).cloned(),
        }
    }

    /// Offer a measurement. `Ok(true)`: kept; `Ok(false)`: a newer one is kept already.
    pub fn put(&self, kind: &str, cluster: &str, measured_at: u64, mut data: Value, by: &str, now_ms: u64) -> Result<bool, String> {
        check_kind(kind)?;
        // When it was measured is the record's own `measuredAt`, checked here; a second one
        // inside the data would only be a claim a reader might believe instead.
        if let Some(m) = data.as_object_mut() {
            m.remove("measuredAt");
        }
        if cluster.trim().is_empty() {
            return Err("clusterId: the cluster the measurement is of".into());
        }
        if measured_at == 0 || measured_at > now_ms + CLOCK_SKEW_MS {
            return Err("measuredAt: when it was measured, ms since the epoch, not in the future".into());
        }
        if now_ms.saturating_sub(measured_at) >= KEEP_MS {
            return Err("measuredAt: older than 48 hours, which nobody would be shown".into());
        }
        let bytes = data.to_string().len();
        if kind == "delay" {
            match delay_records(&data) {
                None => return Err("data: a delay measurement is a list of device records, or {devices: [...]}".into()),
                Some(n) if n > MAX_DELAY_RECORDS => return Err(format!("data: at most {MAX_DELAY_RECORDS} device records per cluster ({n} sent)")),
                _ => {}
            }
            if bytes > MAX_DELAY_BYTES {
                return Err(format!("data: at most {} KB", MAX_DELAY_BYTES / 1024));
            }
        } else {
            if !data.is_object() {
                return Err("data: a repository size is an object".into());
            }
            if bytes > MAX_REPO_BYTES {
                return Err(format!("data: at most {} KB", MAX_REPO_BYTES / 1024));
            }
        }
        let _one = self.writing.lock();
        if self.read(kind, cluster).is_some_and(|r| r.measured_at >= measured_at && now_ms.saturating_sub(r.measured_at) < KEEP_MS) {
            return Ok(false);
        }
        let rec = Record { cluster_id: cluster.to_string(), measured_at, put_at: now_ms, by: by.to_string(), data };
        match self.file(kind, cluster) {
            Some(p) => {
                let body = serde_json::to_vec(&rec).map_err(|e| e.to_string())?;
                super::write_private(&p, &body)?;
            }
            None => {
                self.mem.lock().insert((kind.to_string(), cluster.to_string()), rec);
            }
        }
        Ok(true)
    }

    /// The newest measurement per cluster among `clusters`, younger than 48 h.
    pub fn get(&self, kind: &str, clusters: &[String], now_ms: u64) -> Map<String, Value> {
        let mut out = Map::new();
        for c in clusters {
            if let Some(r) = self.read(kind, c).filter(|r| now_ms.saturating_sub(r.measured_at) < KEEP_MS) {
                out.insert(c.clone(), json!({ "measuredAt": r.measured_at, "putAt": r.put_at, "by": r.by, "data": r.data }));
            }
        }
        out
    }

    /// Delete what is older than 48 h. Returns how many went.
    pub fn sweep(&self, now_ms: u64) -> usize {
        let _one = self.writing.lock();
        let Some(dir) = &self.dir else {
            let mut m = self.mem.lock();
            let before = m.len();
            m.retain(|_, r| now_ms.saturating_sub(r.measured_at) < KEEP_MS);
            return before - m.len();
        };
        let mut gone = 0;
        for kind in KINDS {
            let Ok(rd) = std::fs::read_dir(dir.join(kind)) else { continue };
            for f in rd.flatten() {
                let p = f.path();
                let old = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Record>(&b).ok())
                    .is_none_or(|r| now_ms.saturating_sub(r.measured_at) >= KEEP_MS);
                if old && p.extension().is_some_and(|e| e == "json") && std::fs::remove_file(&p).is_ok() {
                    gone += 1;
                }
            }
        }
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_per_cluster_capped_and_48_hours() {
        let dir = std::env::temp_dir().join(format!("ep-share-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for s in [Share::open(Some(dir.clone())), Share::open(None)] {
            let now = 10 * 86_400_000;
            assert!(s.put("delay", "c/1", now - 1000, json!({ "devices": [{ "device": "fw1", "delayMin": 3 }] }), "tv", now).unwrap());
            assert!(!s.put("delay", "c/1", now - 2000, json!([]), "tv", now).unwrap(), "older than the kept one");
            let got = s.get("delay", &["c/1".to_string(), "c2".to_string()], now);
            assert_eq!(got.len(), 1);
            assert_eq!(got["c/1"]["data"]["devices"][0]["device"], json!("fw1"));
            let many: Vec<Value> = (0..=MAX_DELAY_RECORDS).map(|i| json!({ "d": i })).collect();
            assert!(s.put("delay", "c2", now, Value::Array(many), "tv", now).unwrap_err().contains("2000"));
            assert!(s.put("delay", "c2", now, json!({ "x": 1 }), "tv", now).is_err(), "not a delay measurement");
            assert!(s.put("repoSize", "c2", now, json!({ "repo": "r", "bytes": "x".repeat(MAX_REPO_BYTES) }), "u", now).is_err());
            assert!(s.put("other", "c2", now, json!({}), "u", now).is_err());
            assert!(s.put("delay", "c2", now - KEEP_MS, json!([]), "u", now).is_err(), "too old to keep");
            assert!(s.put("delay", "c2", now + 3_600_000, json!([]), "u", now).is_err(), "from the future");
            // 48 h later it is gone, and the sweep deletes it.
            assert!(s.get("delay", &["c/1".to_string()], now + KEEP_MS).is_empty());
            assert_eq!(s.sweep(now + KEEP_MS), 1);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_time_inside_the_data_is_not_kept() {
        let s = Share::open(None);
        let now = 10 * 86_400_000;
        let data = json!({ "devices": [{ "device": "fw1", "delayMinutes": 3 }], "truncated": 0, "measuredAt": now + 99 });
        assert!(s.put("delay", "c1", now - 5, data, "tv", now).unwrap());
        let got = s.get("delay", &["c1".to_string()], now);
        assert_eq!(got["c1"]["measuredAt"], json!(now - 5));
        assert!(got["c1"]["data"].get("measuredAt").is_none(), "only the record's own time is kept");
        assert_eq!(got["c1"]["data"]["devices"][0]["device"], json!("fw1"));
    }
}
