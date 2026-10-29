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
//! waiting for an end nobody has announced. Run it again when the stop is over. A job whose
//! period the record already holds in full (every day final, gone from the cluster, or
//! never there) asks the cluster nothing, so it is built under the stop too. The mailed
//! schedule does not fail: it is simply not due while the stop is on, and goes out on the
//! first tick after; a scheduled job the stop (or a restart) cuts short gives its period
//! back to the schedule, so that tick tries it again.

pub mod build;
pub mod jobs;
pub mod mail;
pub mod period;
pub mod schedule;
pub mod xlsx;
pub mod zip;
mod run;

use crate::volume::store::write_atomic;
use jobs::{Job, Kind, Queue};
use schedule::{LastSent, ReportSchedule, Retry};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const JOBS_FILE: &str = "jobs.json";
/// Who the schedule's jobs and mails are by: nobody asked.
pub const SCHEDULE_BY: &str = "(schedule)";
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
    /// Writes `jobs.json` off the caller's thread (`save`).
    writer: Arc<Writer>,
}

/// The queue file's writer: one thread at a time, the latest body only. The queue changes
/// on every promotion, end and stop — from async code, under the queue's lock — so a write
/// is handed over here instead of being made where the change is: no worker of the async
/// runtime waits on the disk, and a burst of changes is one write of the last state. The
/// thread exists only while there is something to write.
#[derive(Default)]
struct Writer {
    state: parking_lot::Mutex<WriterState>,
    idle: parking_lot::Condvar,
}

#[derive(Default)]
struct WriterState {
    pending: Option<(PathBuf, Vec<u8>)>,
    running: bool,
}

impl Writer {
    fn hand(self: &Arc<Self>, path: PathBuf, body: Vec<u8>) {
        let mut st = self.state.lock();
        st.pending = Some((path, body));
        if st.running {
            return;
        }
        st.running = true;
        drop(st);
        let me = self.clone();
        let spawned = std::thread::Builder::new().name("report-queue-writer".into()).spawn(move || me.drain());
        if spawned.is_err() {
            // No thread to be had: write here rather than not at all.
            self.drain();
        }
    }

    fn drain(&self) {
        loop {
            let next = {
                let mut st = self.state.lock();
                match st.pending.take() {
                    Some(n) => n,
                    None => {
                        st.running = false;
                        self.idle.notify_all();
                        return;
                    }
                }
            };
            if let Err(e) = write_atomic(&next.0, &next.1) {
                tracing::warn!(error = %e, "volume report: the queue could not be written");
            }
        }
    }

    /// Wait until everything handed over is on disk.
    fn flush(&self) {
        let mut st = self.state.lock();
        while st.running || st.pending.is_some() {
            self.idle.wait(&mut st);
        }
    }
}

impl Drop for Reports {
    fn drop(&mut self) {
        self.writer.flush();
    }
}

impl Reports {
    /// Load the queue; whatever was running when the process ended is marked failed, and a
    /// mailed job among them is recorded as the schedule's last send (not sent) — giving its
    /// period back to the schedule when its mail had not begun.
    pub fn open(data_dir: Option<&Path>) -> Reports {
        let data = data_dir.map(Path::to_path_buf);
        let mut q: Queue = data.as_ref()
            .and_then(|d| std::fs::read(d.join("reports").join(JOBS_FILE)).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let now = crate::fleet::now_ms() as i64;
        let failed = q.restarted(now);
        let r = Reports { data, queue: parking_lot::Mutex::new(Queue::default()), ticking: Default::default(),
                          settings_lock: Default::default(), writer: Default::default() };
        if !failed.is_empty() {
            tracing::warn!(jobs = failed.len(), "volume report: jobs running when the core stopped were marked failed");
            r.save(&q);
            for j in failed.iter().filter(|j| j.kind == Kind::Mailed) {
                let (error, retry) = match j.mail_started_at {
                    Some(_) => ("the server restarted while the mail was being sent: it may have gone out, so it is not sent again".to_string(), Retry::No),
                    None => (jobs::RESTARTED.to_string(), Retry::Restart),
                };
                r.mailed_ended(j, LastSent { at: now, to: 0, ok: false, error: Some(error) }, retry);
            }
        }
        *r.queue.lock() = q;
        r
    }

    /// A mailed job ended: record it as the schedule's last send, and — for a job of the
    /// schedule's own that did not send — give its period back when `retry` says so (the
    /// emergency stop; a restart before the mail, once). Returns whether the period was given
    /// back. `REPORT_SEND_NOW` jobs are recorded but never give a period back: the schedule
    /// did not queue them.
    pub(crate) fn mailed_ended(&self, job: &Job, last: LastSent, retry: Retry) -> bool {
        let _g = self.settings_lock.lock();
        let mut f: ReportSchedule = self.read_json(schedule::FILE);
        f.last_sent = Some(last);
        let back = job.by == SCHEDULE_BY && schedule::give_back(&mut f, &schedule::period_key(&job.period), retry);
        if let Err(e) = self.write_json(schedule::FILE, &f) {
            tracing::warn!(error = %e, "volume report: the last send could not be recorded");
            return false;
        }
        if back {
            tracing::info!(period = %job.period.label, retry = ?retry, "volume report: the scheduled report was not sent; the next tick tries again");
        }
        back
    }

    pub fn data_dir(&self) -> Option<&Path> {
        self.data.as_deref()
    }

    pub fn dir(&self) -> Option<PathBuf> {
        self.data.as_ref().map(|d| d.join("reports"))
    }

    /// Write the queue (tmp + rename, 0600), compact, by the writer thread: the caller only
    /// serialises it. A failure is logged, not fatal: the queue in memory is still right,
    /// and the next change writes it again.
    pub(crate) fn save(&self, q: &Queue) {
        let Some(dir) = self.dir() else { return };
        let body = match serde_json::to_vec(q) {
            Ok(b) => b,
            Err(e) => return tracing::warn!(error = %e, "volume report: the queue could not be serialised"),
        };
        self.writer.hand(dir.join(JOBS_FILE), body);
    }

    /// Wait until the queue's last change is on disk.
    pub fn flush(&self) {
        self.writer.flush();
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
        r.flush();
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
    fn queue_writes_leave_the_caller_and_the_last_state_wins() {
        let d = tmp();
        let r = Reports::open(Some(&d));
        let p: period::Period = serde_json::from_value(serde_json::json!({ "from": "2026-10-01", "to": "2026-10-01", "label": "x" })).unwrap();
        // The writer thread is busy with the directory: the caller does not wait for it.
        for i in 0..200 {
            r.with(|q| q.push(Job::new(Kind::Cluster, vec!["a".into()], "a".into(), p.clone(), Format::Xlsx, false, "ann", i), format!("j{i}")));
        }
        r.flush();
        let text = std::fs::read_to_string(d.join("reports").join(JOBS_FILE)).unwrap();
        assert!(!text.contains("\n  "), "compact, not pretty");
        let back: Queue = serde_json::from_str(&text).unwrap();
        assert_eq!(back.jobs.len(), 200, "the last state is the one on disk");
        drop(r);
        std::fs::remove_dir_all(d).ok();
    }

    fn mailed_job(by: &str, mail_started: bool) -> Job {
        let p: period::Period = serde_json::from_value(serde_json::json!({ "from": "2026-10-01", "to": "2026-10-31", "label": "2026-10" })).unwrap();
        let mut j = Job::new(Kind::Mailed, vec!["a".into()], "a".into(), p, Format::Xlsx, true, by, 1);
        j.mail_started_at = mail_started.then_some(5);
        j
    }

    #[test]
    fn a_restart_records_a_mailed_job_and_gives_its_period_back_once() {
        let key = "2026-10-01..2026-10-31";
        for (by, started, back) in [(SCHEDULE_BY, false, true), (SCHEDULE_BY, true, false), ("root", false, false)] {
            let d = tmp();
            let r = Reports::open(Some(&d));
            let sched = ReportSchedule { last_period: Some(key.into()), ..ReportSchedule::default() };
            r.write_json(schedule::FILE, &sched).unwrap();
            r.with(|q| {
                q.push(mailed_job(by, started), "m1".into());
                q.promote(2);
            });
            drop(r);
            let again = Reports::open(Some(&d));
            let f: ReportSchedule = again.read_json(schedule::FILE);
            let last = f.last_sent.clone().expect("recorded");
            assert!(!last.ok, "{last:?}");
            assert_eq!(f.last_period.is_none(), back, "by {by}, mail started {started}: {f:?}");
            if started {
                assert!(last.error.unwrap().contains("may have gone out"));
            } else {
                assert_eq!(last.error.as_deref(), Some(jobs::RESTARTED));
            }
            drop(again);
            if back {
                // Queued again, running at the next restart: not given back a second time.
                let r = Reports::open(Some(&d));
                r.write_json(schedule::FILE, &ReportSchedule { last_period: Some(key.into()), ..r.read_json(schedule::FILE) }).unwrap();
                r.with(|q| {
                    q.push(mailed_job(by, false), "m2".into());
                    q.promote(3);
                });
                drop(r);
                let third = Reports::open(Some(&d));
                let f: ReportSchedule = third.read_json(schedule::FILE);
                assert_eq!(f.last_period.as_deref(), Some(key), "once per period: {f:?}");
            }
            std::fs::remove_dir_all(d).ok();
        }
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
