//! The record on disk.
//!
//! ```text
//!   <data>/volume/<escaped cluster id>/YYYY-MM.json.gz   {version:1, days:{"2026-10-20": Day}}
//!   <data>/volume/<escaped cluster id>/state.json        run status + month summaries
//!   <data>/volume/layouts.json                           the shared column layouts
//! ```
//!
//! Every write is a temporary file and a rename, 0600, so a reader never sees half a
//! file and a crash leaves the previous version. Nothing is cached here: each call reads
//! what it needs and lets it go (production runs under a 1 GB limit, and a record of
//! 36 months × 300 clusters is not something to keep resident for a page nobody opened).
//!
//! The ids are escaped the way the fleet cache escapes them (`fleet::store::escape`): an id
//! comes from a config or from Zabbix, and a slash in one is a way out of this directory.

use super::derive::MonthSummary;
use super::Day;
use crate::fleet::store::escape;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MonthFile {
    pub version: u32,
    #[serde(default)]
    pub days: BTreeMap<String, Day>,
}

/// One cluster's run status and month summaries. Small on purpose: the all-cluster
/// Monthly view reads one of these per cluster and nothing else.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterState {
    #[serde(default)]
    pub version: u32,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    /// The local date of the last scheduled run, so a restart neither repeats today's run
    /// nor skips a missed one.
    pub last_scheduled_day: Option<String>,
    #[serde(default)]
    pub matched: u64,
    #[serde(default)]
    pub skipped: Vec<String>,
    #[serde(default)]
    pub skipped_count: u64,
    #[serde(default)]
    pub months: BTreeMap<String, MonthSummary>,
}

pub struct Store {
    root: PathBuf,
    /// One read-modify-write of a state file at a time: the timer marking a day as run and
    /// a run finishing must not each write over the other.
    lock: parking_lot::Mutex<()>,
}

#[cfg(unix)]
fn private(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn private(_: &Path, _: u32) {}

/// Write `bytes` to `p` through a temporary file: created 0600, synced, renamed. The
/// report queue and the mail settings are written the same way (`report`).
pub(crate) fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        private(d, 0o700);
    }
    let tmp = p.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        use std::io::Write as _;
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", p.display())
    })
}

/// `YYYY-MM`, nothing else: it becomes a file name.
fn month_ok(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
}

impl Store {
    pub fn new(root: PathBuf) -> Store {
        Store { root, lock: parking_lot::Mutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, cluster: &str) -> PathBuf {
        self.root.join(escape(cluster))
    }

    fn month_path(&self, cluster: &str, month: &str) -> Option<PathBuf> {
        month_ok(month).then(|| self.dir(cluster).join(format!("{month}.json.gz")))
    }

    /// One month of one cluster; empty when there is none or it cannot be read. A file
    /// that does not parse is not deleted: it is evidence, and the next write replaces it.
    pub fn read_month(&self, cluster: &str, month: &str) -> MonthFile {
        let Some(p) = self.month_path(cluster, month) else { return MonthFile::default() };
        let Ok(f) = std::fs::File::open(&p) else { return MonthFile::default() };
        let mut text = Vec::new();
        use std::io::Read as _;
        if flate2::read::GzDecoder::new(f).read_to_end(&mut text).is_err() {
            tracing::warn!(file = %p.display(), "volume: a month file could not be read; it will be rewritten");
            return MonthFile::default();
        }
        serde_json::from_slice(&text).unwrap_or_default()
    }

    /// Every kept day from `from` to `to` (inclusive), oldest first: the month files that
    /// range touches, read one at a time and let go.
    pub fn days_between(&self, cluster: &str, from: chrono::NaiveDate, to: chrono::NaiveDate) -> Vec<Day> {
        let mut out = vec![];
        for m in super::schedule::months_between(from, to) {
            out.extend(self.read_month(cluster, &m).days.into_values()
                .filter(|d| super::schedule::parse_day(&d.day).is_some_and(|x| x >= from && x <= to)));
        }
        out
    }

    pub fn write_month(&self, cluster: &str, month: &str, file: &MonthFile) -> Result<(), String> {
        let p = self.month_path(cluster, month).ok_or("not a month")?;
        let body = serde_json::to_vec(&MonthFile { version: 1, days: file.days.clone() }).map_err(|e| e.to_string())?;
        use std::io::Write as _;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&body).map_err(|e| e.to_string())?;
        write_atomic(&p, &enc.finish().map_err(|e| e.to_string())?)
    }

    /// The months kept for a cluster, oldest first.
    pub fn months(&self, cluster: &str) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(self.dir(cluster)).into_iter().flatten().flatten()
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json.gz")).map(String::from))
            .filter(|m| month_ok(m)).collect();
        out.sort();
        out
    }

    pub fn read_state(&self, cluster: &str) -> ClusterState {
        std::fs::read(self.dir(cluster).join("state.json")).ok()
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Change one cluster's state under the store's lock.
    pub fn update_state(&self, cluster: &str, f: impl FnOnce(&mut ClusterState)) -> Result<ClusterState, String> {
        let _g = self.lock.lock();
        let mut s = self.read_state(cluster);
        f(&mut s);
        s.version = 1;
        let body = serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?;
        write_atomic(&self.dir(cluster).join("state.json"), &body)?;
        Ok(s)
    }

    /// Remove month files (and their summaries) older than `oldest` (`YYYY-MM`).
    pub fn prune(&self, cluster: &str, oldest: &str) -> Result<usize, String> {
        let old: Vec<String> = self.months(cluster).into_iter().filter(|m| m.as_str() < oldest).collect();
        for m in &old {
            if let Some(p) = self.month_path(cluster, m) {
                let _ = std::fs::remove_file(p);
            }
        }
        let oldest = oldest.to_string();
        self.update_state(cluster, |s| s.months.retain(|m, _| *m >= oldest))?;
        Ok(old.len())
    }

    pub fn read_layouts(&self) -> Value {
        std::fs::read(self.root.join("layouts.json")).ok()
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
    }

    pub fn write_layouts(&self, v: &Value) -> Result<(), String> {
        let _g = self.lock.lock();
        write_atomic(&self.root.join("layouts.json"), &serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ep-volume-{tag}-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn months_round_trip_gzipped_private_and_pruned() {
        let root = tmp("store");
        let s = Store::new(root.join("volume"));
        let mut f = MonthFile::default();
        f.days.insert("2026-10-20".into(), Day { day: "2026-10-20".into(), live: true, pri_bytes: 5, ..Day::default() });
        s.write_month("a/../b", "2026-10", &f).unwrap();
        s.write_month("a/../b", "2025-09", &f).unwrap();
        let dir = root.join("volume").join("a%2F%2E%2E%2Fb");
        assert!(dir.join("2026-10.json.gz").is_file(), "the id is escaped, not followed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("2026-10.json.gz")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(s.read_month("a/../b", "2026-10").days["2026-10-20"].pri_bytes, 5);
        assert_eq!(s.months("a/../b"), vec!["2025-09", "2026-10"]);
        s.update_state("a/../b", |st| {
            st.months.insert("2025-09".into(), MonthSummary::default());
            st.months.insert("2026-10".into(), MonthSummary::default());
        }).unwrap();
        assert_eq!(s.prune("a/../b", "2025-10").unwrap(), 1);
        assert_eq!(s.months("a/../b"), vec!["2026-10"]);
        assert_eq!(s.read_state("a/../b").months.keys().collect::<Vec<_>>(), vec!["2026-10"]);
        assert!(s.read_month("x", "../etc").days.is_empty(), "a month that is not YYYY-MM is no file");
        std::fs::remove_dir_all(&root).ok();
    }
}
