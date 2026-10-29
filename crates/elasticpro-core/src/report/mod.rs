//! Volume reports and the mail that carries them (docs/VOLUME.md "Reports and mail").
//!
//! ```text
//!   REPORT_RUN ──▶ one job per cluster ─┐                      ┌─▶ <data>/reports/<id>-volume-….xlsx
//!   schedule tick / REPORT_SEND_NOW ────┴▶ queue (3..5 at once) ┤      (REPORT_DOWNLOAD, 7 days)
//!                                          FIFO, jobs.json      └─▶ SMTP (mail.json + config.txt)
//!   a job:  collect the period's missing days (volume's collector, stoppable between days)
//!           → build the file (every figure from volume::derive) → mail it when asked
//! ```
//!
//! * `jobs` — the queue's rules, pure; `period` — which days; `schedule` — the mailed
//!   report's settings and when it is due; `build` — sheets and CSV from `volume::derive`;
//!   `xlsx`/`zip` — the file format; `mail` — the mail server and one SMTP session.
//! * Nothing here writes to a cluster: a job only reads, through the collector, under the
//!   same rules as the daily run (Background class, the emergency stop, one request at a
//!   time per cluster, at most two clusters collecting at once).
//! * The timer (queued jobs after a restart, the 7-day prune, the mailed schedule) exists
//!   only on hosted and is started by the bridge binary, like the volume timer.
//!
//! The emergency stop: a job that meets it fails, saying so — it does not sit in a slot
//! waiting for an end nobody has announced. Run it again when the stop is over. The mailed
//! schedule does not fail: it is simply not due while the stop is on, and goes out on the
//! first tick after.

pub mod build;
pub mod jobs;
pub mod mail;
pub mod period;
pub mod schedule;
pub mod xlsx;
pub mod zip;
mod run;

use crate::volume::store::write_atomic;
use jobs::Queue;
use std::path::{Path, PathBuf};

pub const JOBS_FILE: &str = "jobs.json";
/// Days a report file is kept in `<data>/reports/`.
pub const KEEP_FILE_DAYS: u64 = 7;
/// The largest file `REPORT_DOWNLOAD` hands back through the message API (base64).
pub const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// The core's handle on reports: the queue and where its files are.
pub struct Reports {
    data: Option<PathBuf>,
    pub(crate) queue: parking_lot::Mutex<Queue>,
    /// One tick at a time.
    pub(crate) ticking: std::sync::atomic::AtomicBool,
    /// One read-modify-write of `mail.json` or `report-schedule.json` at a time.
    pub(crate) settings_lock: parking_lot::Mutex<()>,
}

impl Reports {
    /// Load the queue; whatever was running when the process ended is marked failed.
    pub fn open(data_dir: Option<&Path>) -> Reports {
        let data = data_dir.map(Path::to_path_buf);
        let mut q: Queue = data.as_ref()
            .and_then(|d| std::fs::read(d.join("reports").join(JOBS_FILE)).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let failed = q.restarted(crate::fleet::now_ms() as i64);
        let r = Reports { data, queue: parking_lot::Mutex::new(Queue::default()), ticking: Default::default(), settings_lock: Default::default() };
        if failed > 0 {
            tracing::warn!(jobs = failed, "volume report: jobs running when the core stopped were marked failed");
            r.save(&q);
        }
        *r.queue.lock() = q;
        r
    }

    pub fn data_dir(&self) -> Option<&Path> {
        self.data.as_deref()
    }

    pub fn dir(&self) -> Option<PathBuf> {
        self.data.as_ref().map(|d| d.join("reports"))
    }

    /// Write the queue (tmp + rename, 0600). A failure is logged, not fatal: the queue in
    /// memory is still right, and the next change writes it again.
    pub(crate) fn save(&self, q: &Queue) {
        let Some(dir) = self.dir() else { return };
        let body = match serde_json::to_vec_pretty(q) {
            Ok(b) => b,
            Err(e) => return tracing::warn!(error = %e, "volume report: the queue could not be serialised"),
        };
        if let Err(e) = write_atomic(&dir.join(JOBS_FILE), &body) {
            tracing::warn!(error = %e, "volume report: the queue could not be written");
        }
    }

    /// Change the queue and write it.
    pub(crate) fn with<R>(&self, f: impl FnOnce(&mut Queue) -> R) -> R {
        let mut q = self.queue.lock();
        let out = f(&mut q);
        self.save(&q);
        out
    }

    /// Where a job's file lives: `<data>/reports/<job id>-<name>`. The id is ours (hex);
    /// the name is built from a sanitised cluster id.
    pub(crate) fn file_path(&self, job_id: &str, name: &str) -> Option<PathBuf> {
        let ok = !job_id.is_empty() && job_id.bytes().all(|b| b.is_ascii_alphanumeric())
            && !name.contains(['/', '\\']) && !name.starts_with('.');
        ok.then(|| self.dir()).flatten().map(|d| d.join(format!("{job_id}-{name}")))
    }

    /// Remove report files older than `KEEP_FILE_DAYS` (by modification time). The queue
    /// file and anything that is not a regular file are left alone.
    pub(crate) fn prune_files(&self, now: std::time::SystemTime) -> usize {
        let Some(dir) = self.dir() else { return 0 };
        let max_age = std::time::Duration::from_secs(KEEP_FILE_DAYS * 86_400);
        let mut n = 0;
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name == JOBS_FILE || name.ends_with(".tmp") {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > max_age);
            if old && std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
        n
    }

    pub(crate) fn read_json<T: serde::de::DeserializeOwned + Default>(&self, file: &str) -> T {
        self.data.as_ref().and_then(|d| std::fs::read(d.join(file)).ok())
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub(crate) fn write_json<T: serde::Serialize>(&self, file: &str, v: &T) -> Result<(), String> {
        let d = self.data.as_ref().ok_or("no data directory")?;
        write_atomic(&d.join(file), &serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jobs::{Format, Job, Kind};

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("ep-reports-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_queue_is_kept_private_and_a_restart_fails_what_ran() {
        let d = tmp();
        let r = Reports::open(Some(&d));
        let p: period::Period = serde_json::from_value(serde_json::json!({ "from": "2026-10-01", "to": "2026-10-01", "label": "x" })).unwrap();
        r.with(|q| {
            q.push(Job::new(Kind::Cluster, vec!["a".into()], "a".into(), p.clone(), Format::Xlsx, false, "ann", 1), "j1".into());
            q.push(Job::new(Kind::Cluster, vec!["b".into()], "b".into(), p.clone(), Format::Xlsx, false, "ann", 1), "j2".into());
            q.promote(2);
            q.concurrency = 3;
        });
        let f = d.join("reports").join(JOBS_FILE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let again = Reports::open(Some(&d));
        let q = again.queue.lock();
        assert_eq!(q.get("j1").unwrap().status, jobs::Status::Failed);
        assert_eq!(q.get("j1").unwrap().error.as_deref(), Some("the server restarted"));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn files_are_pruned_after_seven_days_and_names_cannot_escape() {
        let d = tmp();
        let r = Reports::open(Some(&d));
        let dir = r.dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let f = r.file_path("abc123", "volume-x.xlsx").unwrap();
        std::fs::write(&f, b"x").unwrap();
        std::fs::write(dir.join(JOBS_FILE), b"{}").unwrap();
        let now = std::time::SystemTime::now();
        assert_eq!(r.prune_files(now), 0, "fresh");
        assert_eq!(r.prune_files(now + std::time::Duration::from_secs(8 * 86_400)), 1, "a week and a day later");
        assert!(!f.exists() && dir.join(JOBS_FILE).exists(), "the queue file is never pruned");
        assert!(r.file_path("../x", "a").is_none());
        assert!(r.file_path("abc", "../../etc/passwd").is_none());
        assert!(r.file_path("abc", ".hidden").is_none());
        assert!(Reports::open(None).file_path("abc", "a").is_none(), "no data directory: no files");
        std::fs::remove_dir_all(d).ok();
    }
}
