//! The core's half: the `REPORT_*` and `MAIL_*` messages, the workers, and the timer.
//!
//! A worker runs one job: it collects the period's missing days through the volume
//! collector (`Core::volume_collect`, origin `volume-report`), builds the file from
//! `volume::derive` (`build`), keeps it in `<data>/reports/` and mails it when asked. The
//! queue decides how many run (`jobs`); a worker that ends starts the next one.
//!
//! Collection takes the same two locks the daily run does — the cluster's run flag (one
//! collection per cluster at a time, the daily run included) and one of the two
//! collection permits — and gives them back between clusters. Both waits answer to
//! `REPORT_STOP`.

use super::build::{self, ClusterData};
use super::jobs::{FileRef, Format, Job, Kind, Progress, Status, Which, MAX_CONCURRENCY, MIN_CONCURRENCY};
use super::mail::{self, Auth, MailFile, PasswordFrom, Ready};
use super::period::{self, Period};
use super::schedule::{self as rsched, Cadence, Clock, LastSent, ReportSchedule, Retry};
use super::{xlsx, zip, MAX_DOWNLOAD_BYTES, SCHEDULE_BY};
use crate::auth::{Caller, Edition, Role};
use crate::bridge::Core;
use crate::volume::run::CollectOpts;
use crate::volume::schedule::{self as vsched, day_key};
use crate::volume::VolumeSettings;
use chrono::{Datelike, NaiveDateTime};
use serde_json::{json, Value};
use std::sync::Arc;

fn now_ms() -> i64 {
    crate::fleet::now_ms() as i64
}

fn bad(kind: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "message": message.into() })
}

fn no_store() -> Value {
    bad("no_store", "this core keeps no files (no data directory), so it keeps no reports")
}

fn who(caller: Option<&Caller>) -> String {
    caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into())
}

/// Portable has no accounts: its one person is the administrator.
fn is_admin(caller: Option<&Caller>) -> bool {
    caller.is_none_or(|c| c.role >= Role::Admin)
}

/// A job as the pages see it: without the desktop settings it carries, with whether a stop
/// was asked for.
fn job_view(j: &Job) -> Value {
    let mut v = serde_json::to_value(j).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("volume");
        o.remove("seq");
        o.remove("mailStartedAt");
        o.insert("stopping".into(), json!(j.stop_asked.is_some()));
    }
    v
}

/// How a job ended, before it is written into the queue.
struct JobEnd {
    status: Status,
    file: Option<FileRef>,
    error: Option<String>,
    mail_error: Option<String>,
    warning: Option<String>,
    stopped_by: Option<String>,
    /// It ended because of the emergency stop: the schedule tries its period again.
    retry: bool,
    /// The mail's recipients, when it got as far as the mail.
    recipients: usize,
}

impl JobEnd {
    fn failed(e: impl Into<String>) -> JobEnd {
        JobEnd { status: Status::Failed, file: None, error: Some(e.into()), mail_error: None, warning: None, stopped_by: None, retry: false, recipients: 0 }
    }
    /// Failed because the emergency stop is (or came) on.
    fn held(e: impl Into<String>) -> JobEnd {
        JobEnd { retry: true, ..JobEnd::failed(e) }
    }
    fn stopped(by: String) -> JobEnd {
        JobEnd { status: Status::Stopped, stopped_by: Some(by), error: None, ..JobEnd::failed("") }
    }
    fn done(file: FileRef, warning: Option<String>) -> JobEnd {
        JobEnd { status: Status::Done, file: Some(file), error: None, warning, ..JobEnd::failed("") }
    }

    /// The mailed report's last send, as this end says it went.
    fn last_sent(&self, at: i64) -> LastSent {
        let ok = self.status == Status::Done && self.mail_error.is_none();
        let error = (!ok).then(|| {
            self.error.clone().or_else(|| self.mail_error.clone())
                .or_else(|| self.stopped_by.as_ref().map(|by| format!("stopped by {by} before the mail went")))
                .unwrap_or_else(|| "not sent".into())
        });
        LastSent { at, to: self.recipients, ok, error }
    }
}

/// The cluster's run flag, held: given back when dropped, whatever way the job ends.
struct Slot<'a> {
    core: &'a Core,
    id: String,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if let Some(r) = self.core.volume.runs.lock().get_mut(&self.id) {
            r.running = false;
        }
    }
}

/// Every day of the period is settled in the record: nothing to ask the cluster. A day is
/// settled when its record is final, or gone from the cluster (`live: false`, never changed
/// again), or when it has no record and either comes before the oldest day the record keeps
/// or had ended before the last whole `_cat` listing (`listed_at`) — which would have given
/// it a record had it had an index. Today never is.
pub(crate) fn record_complete(store: &crate::volume::store::Store, id: &str, p: &Period, today: chrono::NaiveDate) -> bool {
    if p.to_date() >= today {
        return false;
    }
    let oldest = store.months(id).first()
        .and_then(|m| store.read_month(id, m).days.keys().next().and_then(|k| crate::volume::schedule::parse_day(k)));
    let listed = store.read_state(id).listed_at.map(vsched::utc_day);
    let kept: std::collections::HashMap<String, (bool, bool)> =
        store.days_between(id, p.from_date(), p.to_date()).into_iter().map(|d| (d.day, (d.is_final, d.live))).collect();
    p.days().iter().all(|d| match kept.get(&day_key(*d)) {
        Some((is_final, live)) => *is_final || !*live,
        None => oldest.is_some_and(|o| *d < o) || listed.is_some_and(|l| *d < l),
    })
}

impl Core {
    /// Every `REPORT_*` / `MAIL_*` message. The gate has checked the role, and that the
    /// clusters `REPORT_RUN` names are the caller's.
    pub(crate) async fn report_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.reports.data_dir().is_none() || self.volume.store.is_none() {
            return no_store();
        }
        match t {
            "REPORT_RUN" => self.report_run(msg, caller).await,
            "REPORT_JOBS" => self.report_jobs(caller),
            "REPORT_STOP" => self.report_stop(msg, caller),
            "REPORT_CLEAR" => self.report_clear(caller),
            "REPORT_DOWNLOAD" => self.report_download(msg, caller),
            "REPORT_CONCURRENCY_SET" => self.report_concurrency(msg, caller),
            "MAIL_SETTINGS_GET" => self.mail_settings_get(),
            "MAIL_SETTINGS_SET" => self.mail_settings_set(msg, caller),
            "MAIL_TEST" => self.mail_test(msg, caller).await,
            "REPORT_SCHEDULE_GET" => self.report_schedule_get(),
            "REPORT_SCHEDULE_SET" => self.report_schedule_set(msg, caller),
            "REPORT_SEND_NOW" => self.report_send_now(msg, caller),
            _ => bad("bad_message", format!("Unknown message type {t:?}")),
        }
    }

    /* ---------------------------------------- the queue ---------------------------------------- */

    /// A job is shown to whoever sees every cluster it covers.
    fn report_visible(&self, caller: Option<&Caller>) -> impl Fn(&Job) -> bool {
        let vis = self.visible_ids(caller);
        move |j: &Job| vis.as_ref().is_none_or(|v| j.cluster_ids.iter().all(|c| v.contains(c)))
    }

    /// `REPORT_RUN {clusterIds, period, format, mail}`: one job per cluster. At most
    /// `MAX_PENDING_PER_USER` of a person's jobs wait or run at once, and at most
    /// `MAX_MAILED_PER_HOUR` mailed ones are asked for an hour (`too_many_jobs`,
    /// `too_many_mails`): the whole request is refused, nothing is queued.
    async fn report_run(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let ids: Vec<String> = match msg.get("clusterIds").and_then(Value::as_array) {
            Some(a) if !a.is_empty() => a.iter().filter_map(Value::as_str).map(String::from).collect(),
            _ => return bad("bad_request", "clusterIds is required: one job per cluster"),
        };
        if ids.len() > 500 {
            return bad("bad_request", "at most 500 clusters at once");
        }
        let today = vsched::utc_day(now_ms());
        let period = match period::parse(msg.get("period").unwrap_or(&Value::Null), today) {
            Ok(p) => p,
            Err(e) => return bad("bad_request", e),
        };
        let fmt = msg.get("format").and_then(Value::as_str).unwrap_or("xlsx");
        let Some(format) = Format::parse(fmt) else { return bad("bad_request", "format must be xlsx or csvzip") };
        let mail = msg.get("mail").and_then(Value::as_bool).unwrap_or(false);
        // Desktop has no config file: the settings come with the message, as for VOLUME_*.
        let volume = msg.get("volume").filter(|v| v.is_object() && self.edition() != Edition::Hosted).cloned();
        let visible = self.fleet_visible(caller);
        let by = who(caller);
        let (mut jobs, mut refused, mut seen) = (vec![], vec![], std::collections::HashSet::new());
        for id in ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            if !visible.contains(&id) {
                refused.push(json!({ "clusterId": id, "reason": "unknown" }));
                continue;
            }
            let name = self.spec_for(&id).and_then(|s| s.name).unwrap_or_else(|| id.clone());
            let mut job = Job::new(Kind::Cluster, vec![id], name, period.clone(), format, mail, &by, now_ms());
            job.volume = volume.clone();
            jobs.push(job);
        }
        let queued: Result<Vec<String>, (&str, String)> = self.reports.with(|q| {
            let n = jobs.len();
            let mailed = if mail { n } else { 0 };
            q.room(&by, n, mailed, now_ms())?;
            q.note_mailed(&by, mailed, now_ms());
            Ok(jobs.into_iter().map(|j| q.push(j, crate::auth::random_hex(8))).collect())
        });
        let ids = match queued {
            Ok(ids) => ids,
            Err((kind, message)) => return bad(kind, message),
        };
        self.report_pump();
        tracing::info!(user = %by, jobs = ids.len(), period = %period.label, "volume report: queued");
        let q = self.reports.queue.lock();
        let out: Vec<Value> = ids.iter().filter_map(|id| q.get(id)).map(job_view).collect();
        json!({ "ok": true, "jobs": out, "refused": refused })
    }

    fn report_jobs(self: &Arc<Self>, caller: Option<&Caller>) -> Value {
        // A queue left by a restart starts here too (desktop has no timer).
        self.report_pump();
        let seen = self.report_visible(caller);
        let q = self.reports.queue.lock();
        let mut jobs: Vec<&Job> = q.jobs.iter().filter(|j| seen(j)).collect();
        jobs.sort_by(|a, b| b.seq.cmp(&a.seq));
        json!({ "ok": true, "jobs": jobs.into_iter().map(job_view).collect::<Vec<_>>(),
                "concurrency": q.concurrency, "running": q.running(), "queued": q.queued() })
    }

    /// `REPORT_STOP {id}` or `{all:true}` (admin).
    fn report_stop(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let by = who(caller);
        let which = if msg.get("all").and_then(Value::as_bool) == Some(true) {
            Which::All
        } else {
            match msg.get("id").and_then(Value::as_str) {
                Some(id) => {
                    if self.reports.queue.lock().get(id).is_none() {
                        return bad("not_found", format!("no job {id:?}"));
                    }
                    Which::One(id)
                }
                None => return bad("bad_request", "id or all:true is required"),
            }
        };
        let (ended, asked) = self.reports.with(|q| q.stop(which, &by, now_ms()));
        // A mailed job stopped before it began is a send that did not happen, too.
        let mailed: Vec<Job> = {
            let q = self.reports.queue.lock();
            ended.iter().filter_map(|id| q.get(id)).filter(|j| j.kind == Kind::Mailed).cloned().collect()
        };
        for j in &mailed {
            let last = LastSent { at: now_ms(), to: 0, ok: false, error: Some(format!("stopped by {by} before it began")) };
            self.reports.mailed_ended(j, last, Retry::No);
        }
        tracing::info!(target: "audit", user = %by, stopped = ended.len(), stopping = asked.len(), "volume report: jobs stopped");
        json!({ "ok": true, "stopped": ended, "stopping": asked })
    }

    /// `REPORT_CLEAR`: the caller's finished jobs (an admin's: everyone's), and their files.
    fn report_clear(&self, caller: Option<&Caller>) -> Value {
        let by = who(caller);
        let mine = (!is_admin(caller)).then_some(by.as_str());
        let gone = self.reports.with(|q| q.clear(mine));
        for j in &gone {
            if let Some(p) = j.file.as_ref().and_then(|f| self.reports.file_path(&j.id, &f.name)) {
                let _ = std::fs::remove_file(p);
            }
        }
        json!({ "ok": true, "removed": gone.len() })
    }

    /// `REPORT_DOWNLOAD {id}`: the starter's or an admin's, while the file is kept.
    fn report_download(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(id) = msg.get("id").and_then(Value::as_str) else { return bad("bad_request", "id is required") };
        let Some(job) = self.reports.queue.lock().get(id).cloned() else { return bad("not_found", format!("no job {id:?}")) };
        if !self.report_visible(caller)(&job) {
            return bad("not_found", format!("no job {id:?}"));
        }
        if !is_admin(caller) && job.by != who(caller) {
            return bad("forbidden", "only the person who started a report, or an administrator, may download it");
        }
        let Some(file) = &job.file else { return bad("not_found", "this job has no file (yet)") };
        let Some(path) = self.reports.file_path(&job.id, &file.name) else { return bad("not_found", "no file") };
        match std::fs::metadata(&path) {
            Ok(m) if m.len() > MAX_DOWNLOAD_BYTES => return bad("too_large", "the file is too large to hand over this way"),
            Ok(_) => {}
            Err(_) => return bad("not_found", format!("the file was removed (files are kept {} days)", super::KEEP_FILE_DAYS)),
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                use base64::Engine as _;
                json!({ "ok": true, "name": file.name, "mime": job.format.mime(), "bytes": bytes.len(),
                        "base64": base64::engine::general_purpose::STANDARD.encode(&bytes) })
            }
            Err(e) => bad("io_error", e.to_string()),
        }
    }

    /// `REPORT_CONCURRENCY_SET {n}` (admin): 3..5.
    fn report_concurrency(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let n = msg.get("n").and_then(Value::as_u64).unwrap_or(0) as usize;
        if !(MIN_CONCURRENCY..=MAX_CONCURRENCY).contains(&n) {
            return bad("bad_request", format!("n must be {MIN_CONCURRENCY} to {MAX_CONCURRENCY}"));
        }
        self.reports.with(|q| q.concurrency = n);
        tracing::info!(target: "audit", user = %who(caller), concurrency = n, "volume report: concurrency set");
        self.report_pump();
        json!({ "ok": true, "concurrency": n })
    }

    /// Start whatever the queue lets start.
    pub(crate) fn report_pump(self: &Arc<Self>) {
        let started = {
            let mut q = self.reports.queue.lock();
            let s = q.promote(now_ms());
            if !s.is_empty() {
                self.reports.save(&q);
            }
            s
        };
        for id in started {
            let core = self.clone();
            tokio::spawn(async move { core.report_work(id).await });
        }
    }

    fn report_progress(&self, id: &str, done: u64, total: u64) {
        if let Some(j) = self.reports.queue.lock().get_mut(id) {
            j.progress = Progress { done, total };
        }
    }

    fn report_stop_asked(&self, id: &str) -> Option<String> {
        self.reports.queue.lock().get(id).and_then(|j| j.stop_asked.clone())
    }

    /* ---------------------------------------- the workers ---------------------------------------- */

    async fn report_work(self: Arc<Self>, id: String) {
        let Some(job) = self.reports.queue.lock().get(&id).cloned() else { return };
        let end = match job.kind {
            Kind::Cluster => self.report_cluster(&job).await,
            Kind::Mailed => self.report_mailed(&job).await,
        };
        if job.kind == Kind::Mailed {
            // Every way a mailed job ends is its last send, sent or not; one the emergency
            // stop cut short gives the schedule its period back, so the next tick retries.
            let retry = if end.retry { Retry::Stop } else { Retry::No };
            self.reports.mailed_ended(&job, end.last_sent(now_ms()), retry);
        }
        let status = end.status;
        self.reports.with(|q| {
            if let Some(j) = q.get_mut(&id) {
                j.status = end.status;
                j.ended_at = Some(now_ms());
                if end.file.is_some() {
                    j.file = end.file;
                }
                j.error = end.error;
                j.mail_error = end.mail_error;
                j.warning = end.warning;
                j.stopped_by = end.stopped_by;
                j.stop_asked = None;
                if status == Status::Done {
                    j.progress.done = j.progress.total;
                }
            }
        });
        tracing::info!(job = %id, status = ?status, "volume report: job ended");
        self.report_pump();
    }

    /// Hold the cluster's run flag, waiting while another collection (the daily run, another
    /// job) has it. `None` when the job was stopped while waiting.
    async fn report_claim(&self, cluster: &str, job_id: &str) -> Option<Slot<'_>> {
        loop {
            {
                let mut runs = self.volume.runs.lock();
                let r = runs.entry(cluster.to_string()).or_default();
                if !r.running {
                    r.running = true;
                    r.done = 0;
                    r.total = 0;
                    return Some(Slot { core: self, id: cluster.to_string() });
                }
            }
            if self.report_stop_asked(job_id).is_some() {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    /// One of the collection permits (two clusters at once, the daily run's included).
    async fn report_permit(&self, job_id: &str) -> Option<tokio::sync::OwnedSemaphorePermit> {
        loop {
            if let Ok(p) = self.volume.permits.clone().try_acquire_owned() {
                return Some(p);
            }
            if self.report_stop_asked(job_id).is_some() {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    /// Collect what the record is missing for one cluster and the period. `acc` is the
    /// job's progress so far (days done, days counted), for a job over several clusters.
    /// `Ok((warning, searched, total))`, or how the job ends.
    async fn report_collect(self: &Arc<Self>, job_id: &str, cluster: &str, s: &VolumeSettings, p: &Period, acc: (u64, u64))
        -> Result<(Option<String>, u64, u64), JobEnd>
    {
        let Some(store) = self.volume.store.as_ref() else { return Err(JobEnd::failed("no data directory")) };
        let today = vsched::utc_day(now_ms());
        if record_complete(store, cluster, p, today) {
            return Ok((None, 0, 0));
        }
        if self.spec_for(cluster).is_none() {
            return Ok((Some(format!("{cluster} is no longer configured: the file has what the record already held")), 0, 0));
        }
        if self.volume_stopped() {
            return Err(JobEnd::held("the emergency stop is on: nothing was sent to the cluster and no day was collected; run the report again when the stop is over"));
        }
        if self.volume_unreachable(cluster) {
            return Ok((Some(format!("{cluster} is unreachable: the file has what the record already held")), 0, 0));
        }
        let stopped = |me: &Self| me.report_stop_asked(job_id).unwrap_or_default();
        let Some(_slot) = self.report_claim(cluster, job_id).await else { return Err(JobEnd::stopped(stopped(self))) };
        let Some(_permit) = self.report_permit(job_id).await else { return Err(JobEnd::stopped(stopped(self))) };
        let stop = || {
            self.report_stop_asked(job_id).map(|by| format!("stopped by {by}"))
                .or_else(|| self.volume_stopped().then(|| "the emergency stop came on".to_string()))
        };
        let progress = |d: u64, t: u64| {
            self.volume_progress(cluster, d, t);
            self.report_progress(job_id, acc.0 + d, acc.1 + t + 1);
        };
        let to = p.to_date().min(today);
        let opts = CollectOpts { origin: "volume-report", period: Some((p.from_date(), to)), stop: &stop, progress: &progress };
        let got = self.volume_collect(cluster, s, &opts).await
            .map_err(|e| if self.volume_stopped() { JobEnd::held(e) } else { JobEnd::failed(e) })?;
        if let Some(why) = got.interrupted {
            if let Some(by) = self.report_stop_asked(job_id) {
                return Err(JobEnd::stopped(by));
            }
            return Err(JobEnd::held(format!("{cluster}: {why} after {} of {} days; run the report again when the stop is over", got.searched, got.total)));
        }
        Ok((got.error.map(|e| format!("{cluster}: {e}")), got.searched, got.total))
    }

    fn report_store_file(&self, job_id: &str, name: &str, bytes: &[u8]) -> Result<FileRef, String> {
        let path = self.reports.file_path(job_id, name).ok_or("no data directory")?;
        crate::volume::store::write_atomic(&path, bytes)?;
        self.reports.prune_files(std::time::SystemTime::now());
        Ok(FileRef { name: name.to_string(), bytes: bytes.len() as u64 })
    }

    async fn report_cluster(self: &Arc<Self>, job: &Job) -> JobEnd {
        let Some(store) = self.volume.store.as_ref() else { return JobEnd::failed("no data directory") };
        let raw = self.volume_config().await;
        let msg = job.volume.as_ref().map(|v| json!({ "volume": v }));
        let s = self.volume_resolve(raw.as_ref(), Some(&job.cluster_id), msg.as_ref()).settings;
        let warning = match self.report_collect(&job.id, &job.cluster_id, &s, &job.period, (0, 0)).await {
            Ok((w, _, _)) => w,
            Err(end) => return end,
        };
        if let Some(by) = self.report_stop_asked(&job.id) {
            return JobEnd::stopped(by);
        }
        let today = vsched::utc_day(now_ms());
        let data = ClusterData::load(store, &job.cluster_id, &job.cluster_name, s.clone(), &job.period);
        let built = match job.format {
            Format::Xlsx => {
                let all: Vec<String> = build::SHEETS.iter().map(|s| s.to_string()).collect();
                let sheets = build::sheets(&data, &job.period, &self.volume_layouts(), today, &all, false);
                xlsx::workbook(&sheets).map(|b| (build::file_name(&job.cluster_id, &job.period, "xlsx"), b))
            }
            Format::CsvZip => zip::write(&build::csv_files(&data, &job.period, today))
                .map(|b| (build::file_name(&job.cluster_id, &job.period, "zip"), b)),
        };
        drop(data);
        let (name, bytes) = match built {
            Ok(x) => x,
            Err(e) => return JobEnd::failed(format!("the file could not be built: {e}")),
        };
        let file = match self.report_store_file(&job.id, &name, &bytes) {
            Ok(f) => f,
            Err(e) => return JobEnd::failed(format!("the file could not be kept: {e}")),
        };
        let mut end = JobEnd::done(file, warning);
        if job.mail {
            if let Some(by) = self.report_stop_asked(&job.id) {
                end.status = Status::Stopped;
                end.stopped_by = Some(by);
                return end;
            }
            let (sched, _) = self.report_schedule_effective();
            let subject = format!("{} · {}", sched.subject_for(&job.period), job.cluster_name);
            let body = format!(
                "ElasticPro volume report · {} · {}\n\n{}\n{}",
                job.cluster_name, job.period.label, build::mail_summary(store, &job.cluster_id, &job.cluster_name, &s, today), MAIL_FOOTER
            );
            if let Err(e) = self.report_mail(&job.by, &subject, &body, Some((&name, job.format.mime(), bytes))).await {
                end.mail_error = Some(e);
            }
        }
        end
    }

    async fn report_mailed(self: &Arc<Self>, job: &Job) -> JobEnd {
        let Some(store) = self.volume.store.as_ref() else { return JobEnd::failed("no data directory") };
        let raw = self.volume_config().await;
        let (mut done, mut counted) = (0u64, 0u64);
        let mut warnings = vec![];
        let mut each: Vec<(String, VolumeSettings)> = vec![];
        for id in &job.cluster_ids {
            let s = self.volume_resolve(raw.as_ref(), Some(id), None).settings;
            match self.report_collect(&job.id, id, &s, &job.period, (done, counted)).await {
                Ok((w, d, t)) => {
                    done += d;
                    counted += t;
                    warnings.extend(w);
                }
                // A person's stop ends the job; the emergency stop fails it (and the
                // schedule tries again when the stop is over).
                Err(end) if end.status == Status::Stopped || end.retry => return end,
                // One cluster that could not be collected does not cost the others their
                // report: its sheets hold what the record has, and the job says so.
                Err(end) => warnings.push(format!("{id}: {}; its sheets hold what the record already had",
                                                  end.error.unwrap_or_else(|| "not collected".into()))),
            }
            each.push((id.clone(), s));
        }
        if let Some(by) = self.report_stop_asked(&job.id) {
            return JobEnd::stopped(by);
        }
        let today = vsched::utc_day(now_ms());
        let layouts = self.volume_layouts();
        let which: Vec<String> = if job.sheets.is_empty() { build::SHEETS.iter().map(|s| s.to_string()).collect() } else { job.sheets.clone() };
        let mut sheets = vec![];
        let mut body = format!("ElasticPro volume report · {}\n\n", job.period.label);
        for (id, s) in &each {
            let name = self.spec_for(id).and_then(|x| x.name).unwrap_or_else(|| id.clone());
            let data = ClusterData::load(store, id, &name, s.clone(), &job.period);
            sheets.extend(build::sheets(&data, &job.period, &layouts, today, &which, true));
            drop(data);
            body.push_str(&build::mail_summary(store, id, &name, s, today));
            body.push('\n');
        }
        body.push_str(MAIL_FOOTER);
        if sheets.is_empty() {
            return JobEnd::failed("no cluster to report on");
        }
        let name = format!("volume-report-{}_{}.xlsx", job.period.from, job.period.to);
        let bytes = match xlsx::workbook(&sheets) {
            Ok(b) => b,
            Err(e) => return JobEnd::failed(format!("the file could not be built: {e}")),
        };
        drop(sheets);
        let file = match self.report_store_file(&job.id, &name, &bytes) {
            Ok(f) => f,
            Err(e) => return JobEnd::failed(format!("the file could not be kept: {e}")),
        };
        self.report_progress(&job.id, done + 1, counted + 1);
        if let Some(by) = self.report_stop_asked(&job.id) {
            let mut end = JobEnd::done(file, None);
            end.status = Status::Stopped;
            end.stopped_by = Some(by);
            return end;
        }
        let (sched, _) = self.report_schedule_effective();
        // Marked, and on disk, before the session: a restart from here on does not send the
        // period again (it may have gone out).
        self.reports.with(|q| {
            if let Some(j) = q.get_mut(&job.id) {
                j.mail_started_at = Some(now_ms());
            }
        });
        let reports = self.clone();
        let _ = tokio::task::spawn_blocking(move || reports.reports.flush()).await;
        let sent = self.report_mail(&job.by, &sched.subject_for(&job.period), &body, Some((&name, xlsx::MIME, bytes))).await;
        let mut end = JobEnd::done(file, (!warnings.is_empty()).then(|| warnings.join("; ")));
        end.recipients = *sent.as_ref().unwrap_or(&sched.recipients());
        end.mail_error = sent.err();
        end
    }

    /* ---------------------------------------- mail ---------------------------------------- */

    fn mail_effective(&self) -> mail::Effective {
        let file: MailFile = self.reports.read_json(mail::FILE);
        mail::effective(&file, crate::settings::get())
    }

    /// The settings with the password opened, ready for a session; or why not.
    fn mail_ready(&self) -> Result<Ready, String> {
        let e = self.mail_effective();
        if let Some(p) = e.problem() {
            return Err(p);
        }
        let credentials = match e.auth {
            Auth::None => None,
            Auth::Password => {
                let pw = match &e.password {
                    PasswordFrom::None => return Err("authentication is on but no password is set".into()),
                    PasswordFrom::Moved => return Err(mail::MOVED.into()),
                    // Opened for the destination in force only: sealed for another, it does not.
                    PasswordFrom::Stored(sealed) => self.cluster_secrets.open_own(&mail::seal_aad(&e.destination()), sealed)
                        .ok_or("the stored mail password does not open for this server with this server's key (was the key or the server changed?); type it again")?,
                    PasswordFrom::File(p) => std::fs::read_to_string(p)
                        .map_err(|err| format!("UI_SMTP_PASSWORD_FILE cannot be read: {err}"))?
                        .trim_end_matches(['\r', '\n']).to_string(),
                };
                if pw.is_empty() {
                    return Err("the mail password is empty".into());
                }
                Some((e.user.clone(), pw))
            }
        };
        Ok(Ready { host: e.host, port: e.port, security: e.security, credentials, from: e.from })
    }

    /// Send a report mail to the schedule's recipients. One audit line, whatever happens:
    /// who, how many recipients, whether it went — never the addresses, never the file.
    async fn report_mail(&self, by: &str, subject: &str, body: &str, attachment: Option<(&str, &str, Vec<u8>)>) -> Result<usize, String> {
        let (sched, _) = self.report_schedule_effective();
        if sched.to.is_empty() {
            return Err("no recipients: set them under Volume report by mail".into());
        }
        let ready = self.mail_ready()?;
        let out = mail::message(&ready.from, &sched.to, &sched.cc, &sched.bcc, subject, body, attachment)?;
        let steps = mail::session(&ready, Some(&out)).await;
        let failed = steps.iter().find(|s| !s.ok).map(|s| format!("{}: {}", s.step, s.detail));
        let ok = failed.is_none() && steps.iter().any(|s| s.step == "send");
        tracing::info!(target: "audit", user = %by, recipients = out.recipients, ok, "volume report mailed");
        match failed {
            None if ok => Ok(out.recipients),
            None => Err("the mail was not sent".into()),
            Some(e) => Err(e),
        }
    }

    fn mail_settings_get(&self) -> Value {
        let mut v = self.mail_effective().view();
        let store = self.cluster_secrets.can_seal_own();
        v["ok"] = json!(true);
        v["canStorePassword"] = json!(store.is_ok());
        v["passwordStoreProblem"] = json!(store.err());
        v
    }

    /// `MAIL_SETTINGS_SET` (admin): the fields given, under the same rules as config.txt.
    /// A field config.txt manages may be sent as it is, not changed. The password only when
    /// typed: empty or absent keeps the stored one, `clearPassword: true` removes it. A typed
    /// password is sealed for the destination these settings end with (host, port, security,
    /// user); a kept one stays bound to the destination it was typed for, so changing the
    /// server without typing it again leaves it unused (`passwordStale`), never sent there.
    fn mail_settings_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let m = msg.get("settings").filter(|v| v.is_object()).unwrap_or(msg);
        let s = crate::settings::get();
        let by = who(caller);
        {
            let _g = self.reports.settings_lock.lock();
            let mut file: MailFile = self.reports.read_json(mail::FILE);
            let before = mail::effective(&file, s);
            let pw_file = matches!(before.password, PasswordFrom::File(_));
            let locked = |field: &str, same: bool| -> Option<Value> {
                let by_key = mail::MANAGED_KEYS.iter().any(|(k, f)| *f == field && s.text(k).is_some());
                (before.managed.contains(&field) && !same).then(|| if by_key || !pw_file {
                    bad("managed", format!("{field} is managed by config.txt"))
                } else {
                    bad("managed", format!("{field} is locked while the password comes from UI_SMTP_PASSWORD_FILE (config.txt): \
                                            that password goes only to the server config.txt names"))
                })
            };
            let text = |k: &str| -> Result<Option<String>, Value> {
                match m.get(k) {
                    None => Ok(None),
                    Some(Value::String(v)) if !v.chars().any(char::is_control) && v.len() <= 320 => Ok(Some(v.trim().to_string())),
                    Some(Value::Null) => Ok(Some(String::new())),
                    _ => Err(bad("bad_request", format!("{k} must be text"))),
                }
            };
            macro_rules! take {
                ($e:expr) => {
                    match $e {
                        Ok(v) => v,
                        Err(r) => return r,
                    }
                };
            }
            if let Some(h) = take!(text("host")) {
                if let Some(r) = locked("host", h == before.host) {
                    return r;
                }
                file.host = h;
            }
            match m.get("port") {
                None => {}
                Some(Value::Null) => {
                    if let Some(r) = locked("port", false) {
                        return r;
                    }
                    file.port = None;
                }
                Some(v) => match v.as_u64().filter(|n| (1..=65_535).contains(n)) {
                    Some(n) => {
                        if let Some(r) = locked("port", n as u16 == before.port) {
                            return r;
                        }
                        file.port = Some(n as u16);
                    }
                    None => return bad("bad_request", "port must be 1-65535"),
                },
            }
            if let Some(v) = take!(text("security")) {
                let Some(sec) = mail::Security::parse(&v) else { return bad("bad_request", "security must be starttls, tls or none") };
                if let Some(r) = locked("security", sec == before.security) {
                    return r;
                }
                file.security = sec;
            }
            if let Some(v) = take!(text("auth")) {
                let a = match v.as_str() {
                    "password" => Auth::Password,
                    "none" => Auth::None,
                    _ => return bad("bad_request", "auth must be password or none"),
                };
                if let Some(r) = locked("auth", a == before.auth) {
                    return r;
                }
                file.auth = a;
            }
            if let Some(u) = take!(text("user")) {
                if let Some(r) = locked("user", u == before.user) {
                    return r;
                }
                file.user = u;
            }
            if let Some(f) = take!(text("from")) {
                if let Some(r) = locked("from", f == before.from) {
                    return r;
                }
                file.from = f;
            }
            let typed = match m.get("password") {
                None | Some(Value::Null) => None,
                Some(Value::String(p)) if p.is_empty() => None,
                Some(Value::String(p)) => {
                    if before.managed.contains(&"password") {
                        return bad("managed", "the password comes from UI_SMTP_PASSWORD_FILE (config.txt)");
                    }
                    Some(p.as_str())
                }
                Some(_) => return bad("bad_request", "password must be text"),
            };
            if m.get("clearPassword").and_then(Value::as_bool) == Some(true) {
                file.password = None;
                file.password_for = None;
            }
            if let Some(p) = typed {
                // Sealed for the server these settings end with, and for no other.
                let dest = mail::effective(&file, s).destination();
                match self.cluster_secrets.seal_own(&mail::seal_aad(&dest), p) {
                    Ok(sealed) => {
                        file.password = Some(sealed);
                        file.password_for = Some(dest);
                    }
                    Err(e) => return bad("cannot_store_password", e),
                }
            }
            let after = mail::effective(&file, s);
            if !after.host.is_empty() || !after.from.is_empty() {
                if let Err(e) = mail::validate(&after.host, after.port, after.security, after.auth, &after.user, &after.from) {
                    return bad("bad_request", e);
                }
            }
            file.set_by = Some(by.clone());
            file.set_at = Some(now_ms());
            if let Err(e) = self.reports.write_json(mail::FILE, &file) {
                return bad("io_error", e);
            }
        }
        tracing::info!(target: "audit", user = %by, "mail server settings saved");
        self.mail_settings_get()
    }

    /// `MAIL_TEST {to}` (admin): one test mail, step by step.
    async fn mail_test(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let by = who(caller);
        let Some(to) = msg.get("to").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
            return bad("bad_request", "to is required");
        };
        if let Err(e) = mail::check_addresses(&[to.to_string()], "to") {
            return bad("bad_request", e);
        }
        let ready = match self.mail_ready() {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "kind": "not_configured", "message": e, "steps": [] }),
        };
        let body = format!(
            "This is a test message from ElasticPro, sent by {by} from Config › Volume fields › Mail server.\n\n\
             If you can read it, the volume report can be mailed through this server.\n"
        );
        let out = match mail::message(&ready.from, &[to.to_string()], &[], &[], "ElasticPro mail server test", &body, None) {
            Ok(o) => o,
            Err(e) => return bad("bad_request", e),
        };
        let steps = mail::session(&ready, Some(&out)).await;
        let ok = steps.iter().all(|s| s.ok) && steps.iter().any(|s| s.step == "send");
        tracing::info!(target: "audit", user = %by, recipients = 1, ok, "mail server test");
        let mut r = json!({ "ok": ok, "steps": steps });
        if !ok {
            r["kind"] = json!("smtp_failed");
            r["message"] = json!(steps.iter().find(|s| !s.ok).map(|s| format!("{}: {}", s.step, s.detail)).unwrap_or_default());
        }
        r
    }

    /* ---------------------------------------- the schedule ---------------------------------------- */

    fn report_schedule_effective(&self) -> (ReportSchedule, Vec<&'static str>) {
        let f: ReportSchedule = self.reports.read_json(rsched::FILE);
        f.effective(crate::settings::get())
    }

    /// The clusters the mailed report covers: the schedule's list, or every cluster.
    fn report_schedule_clusters(&self, s: &ReportSchedule) -> Vec<String> {
        let mut all: Vec<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        all.sort();
        all.dedup();
        match s.cluster_ids() {
            None => all,
            Some(list) => list.into_iter().filter(|i| all.contains(i)).collect(),
        }
    }

    fn report_schedule_get(&self) -> Value {
        let (e, managed) = self.report_schedule_effective();
        let next = self.edition().schedules().then(|| rsched::next_send(&e, Clock::now()).and_then(vsched::local_to_ms)).flatten();
        json!({
            "ok": true, "enabled": e.enabled, "to": e.to, "cc": e.cc, "bcc": e.bcc, "schedule": e.schedule, "at": e.at,
            "clusters": e.clusters, "subject": e.subject, "sheets": e.sheets, "lastSent": e.last_sent,
            "managed": managed, "timer": self.edition().schedules(), "nextSendAt": next,
            "mailConfigured": self.mail_effective().problem().is_none(),
        })
    }

    /// `REPORT_SCHEDULE_SET` (admin): the fields given. Lists are arrays (or a comma list).
    fn report_schedule_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let m = msg.get("settings").filter(|v| v.is_object()).unwrap_or(msg);
        let s = crate::settings::get();
        let by = who(caller);
        {
            let _g = self.reports.settings_lock.lock();
            let mut file: ReportSchedule = self.reports.read_json(rsched::FILE);
            let (before, managed) = file.effective(s);
            let locked = |field: &str, same: bool| -> Option<Value> {
                (managed.contains(&field) && !same).then(|| bad("managed", format!("{field} is managed by config.txt")))
            };
            let list = |k: &str| -> Result<Option<Vec<String>>, Value> {
                match m.get(k) {
                    None => Ok(None),
                    Some(Value::Null) => Ok(Some(vec![])),
                    Some(Value::String(t)) => Ok(Some(rsched::comma_list(t))),
                    Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .collect::<Option<Vec<String>>>().map(|v| Some(v.into_iter().filter(|x| !x.is_empty()).collect()))
                        .ok_or_else(|| bad("bad_request", format!("{k} must be a list of text"))),
                    _ => Err(bad("bad_request", format!("{k} must be a list"))),
                }
            };
            for (k, slot) in [("to", 0), ("cc", 1), ("bcc", 2)] {
                let v = match list(k) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                let Some(v) = v else { continue };
                if let Err(e) = mail::check_addresses(&v, k) {
                    return bad("bad_request", e);
                }
                if slot == 0 {
                    if let Some(r) = locked("to", v == before.to) {
                        return r;
                    }
                    file.to = v;
                } else if slot == 1 {
                    file.cc = v;
                } else {
                    file.bcc = v;
                }
            }
            if let Some(v) = m.get("schedule") {
                let Some(c) = v.as_str().and_then(Cadence::parse) else { return bad("bad_request", "schedule must be monthly, weekly, daily or manual") };
                if let Some(r) = locked("schedule", c == before.schedule) {
                    return r;
                }
                file.schedule = c;
            }
            if let Some(v) = m.get("at") {
                let Some(at) = v.as_str().filter(|a| vsched::parse_hhmm(a).is_some()) else { return bad("bad_request", "at must be HH:MM, 00:00 to 23:59") };
                if let Some(r) = locked("at", at == before.at) {
                    return r;
                }
                file.at = at.to_string();
            }
            match m.get("clusters") {
                None => {}
                Some(Value::String(a)) if a == "all" => file.clusters = json!("all"),
                Some(Value::Array(a)) => {
                    let mut ids = vec![];
                    for x in a {
                        let Some(id) = x.as_str() else { return bad("bad_request", "clusters must be \"all\" or a list of cluster ids") };
                        if self.spec_for(id).is_none() {
                            return bad("bad_request", format!("no cluster {id:?}"));
                        }
                        if !ids.contains(&id.to_string()) {
                            ids.push(id.to_string());
                        }
                    }
                    if ids.is_empty() {
                        return bad("bad_request", "clusters: name at least one, or \"all\"");
                    }
                    file.clusters = json!(ids);
                }
                Some(_) => return bad("bad_request", "clusters must be \"all\" or a list of cluster ids"),
            }
            if let Some(v) = m.get("subject") {
                let Some(sub) = v.as_str().filter(|x| x.chars().count() <= 200 && !x.chars().any(char::is_control)) else {
                    return bad("bad_request", "subject: text, at most 200 characters");
                };
                file.subject = sub.trim().to_string();
            }
            match list("sheets") {
                Err(r) => return r,
                Ok(None) => {}
                Ok(Some(v)) => {
                    let v = match rsched::check_sheets(&v) {
                        Ok(v) => v,
                        Err(e) => return bad("bad_request", e),
                    };
                    if let Some(r) = locked("sheets", v == before.sheets) {
                        return r;
                    }
                    file.sheets = v;
                }
            }
            if let Some(v) = m.get("enabled") {
                let Some(on) = v.as_bool() else { return bad("bad_request", "enabled must be true or false") };
                file.enabled = on;
            }
            let (after, _) = file.effective(s);
            if after.enabled && after.to.is_empty() {
                return bad("bad_request", "add at least one recipient (to) before switching the report on");
            }
            if after.enabled && (!before.enabled || before.schedule != after.schedule || before.at != after.at) {
                let mut tmp = after.clone();
                rsched::mark_passed(&mut tmp, Clock::now());
                file.last_period = tmp.last_period;
            }
            // What was in force when this decision was made: config.txt changing it later is
            // noticed by the tick (`rsched::reconcile`).
            file.seen_schedule = Some(after.schedule);
            file.seen_at = Some(after.at.clone());
            file.set_by = Some(by.clone());
            file.set_at = Some(now_ms());
            if let Err(e) = self.reports.write_json(rsched::FILE, &file) {
                return bad("io_error", e);
            }
        }
        tracing::info!(target: "audit", user = %by, "volume report schedule saved");
        self.report_schedule_get()
    }

    /// Queue the mailed report (one job, one workbook for all its clusters). A person's
    /// (`REPORT_SEND_NOW`) counts toward their waiting jobs; the schedule's does not.
    fn report_queue_mailed(self: &Arc<Self>, ids: Vec<String>, p: Period, s: &ReportSchedule, by: &str) -> Result<String, (&'static str, String)> {
        let name = match ids.as_slice() {
            [one] => self.spec_for(one).and_then(|x| x.name).unwrap_or_else(|| one.clone()),
            many => format!("{} clusters", many.len()),
        };
        let mut job = Job::new(Kind::Mailed, ids, name, p, Format::Xlsx, true, by, now_ms());
        job.cluster_id = "*".into();
        job.sheets = s.sheets.clone();
        let id = self.reports.with(|q| {
            if by != SCHEDULE_BY {
                q.room(by, 1, 0, now_ms())?;
            }
            Ok(q.push(job, crate::auth::random_hex(8)))
        })?;
        self.report_pump();
        Ok(id)
    }

    /// `REPORT_SEND_NOW {period?}` (admin): the mailed report for the current settings, at
    /// once. Without a period: the schedule's (previous month, previous week, yesterday);
    /// for a manual schedule, the current month so far.
    fn report_send_now(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let (e, _) = self.report_schedule_effective();
        if e.to.is_empty() {
            return bad("bad_request", "no recipients: set them under Volume report by mail");
        }
        if let Some(p) = self.mail_effective().problem() {
            return bad("not_configured", p);
        }
        let today = vsched::utc_day(now_ms());
        let p = match msg.get("period").filter(|v| !v.is_null()) {
            Some(v) => match period::parse(v, today) {
                Ok(p) => p,
                Err(err) => return bad("bad_request", err),
            },
            // The schedule's period, from the UTC date like every period; a manual schedule's
            // is the current UTC month so far.
            None => match rsched::current(e.schedule, &e.at, Clock::now()) {
                Some((p, _)) => p,
                None => match period::month(today.year(), today.month(), today) {
                    Ok(p) => p,
                    Err(err) => return bad("bad_request", err),
                },
            },
        };
        let ids = self.report_schedule_clusters(&e);
        if ids.is_empty() {
            return bad("bad_request", "no cluster to report on");
        }
        let by = who(caller);
        let id = match self.report_queue_mailed(ids, p, &e, &by) {
            Ok(id) => id,
            Err((kind, message)) => return bad(kind, message),
        };
        tracing::info!(target: "audit", user = %by, job = %id, "volume report: send now");
        let q = self.reports.queue.lock();
        json!({ "ok": true, "job": q.get(&id).map(job_view) })
    }

    /* ---------------------------------------- the timer ---------------------------------------- */

    /// Queued jobs after a restart, the 7-day prune and the mailed schedule, once a minute.
    /// Hosted only; started by the bridge binary.
    pub fn start_report_timer(self: &Arc<Self>) {
        if !self.edition().schedules() || self.reports.data_dir().is_none() {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                core.report_tick(Clock::now()).await;
            }
        });
        // No `user`: nobody asked. hosted-check counts audit lines that name one.
        tracing::info!(target: "audit", "volume report: timer started");
    }

    /// The day's scheduled collection has finished for every cluster the report covers (an
    /// unreachable one is not waited for: its run is skipped until it is back).
    fn report_daily_collected(&self, s: &ReportSchedule, local: NaiveDateTime) -> bool {
        let Some(store) = &self.volume.store else { return false };
        let today = day_key(local.date());
        self.report_schedule_clusters(s).iter().all(|id| {
            self.volume_unreachable(id) || (store.read_state(id).last_scheduled_day.as_deref() == Some(today.as_str())
                && !self.volume.runs.lock().get(id).is_some_and(|r| r.running))
        })
    }

    /// One tick at the given server local time (with the server's UTC offset at that time).
    /// Returns the mailed job queued, if the schedule was due. Public for the tests, which
    /// cannot wait for the 1st.
    #[doc(hidden)]
    pub async fn report_tick_at(self: &Arc<Self>, local: NaiveDateTime) -> Option<String> {
        self.report_tick(Clock::at_local(local)).await
    }

    async fn report_tick(self: &Arc<Self>, clock: Clock) -> Option<String> {
        use std::sync::atomic::Ordering;
        if self.reports.ticking.swap(true, Ordering::SeqCst) {
            return None;
        }
        struct Done<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _done = Done(&self.reports.ticking);
        self.report_pump();
        self.reports.prune_files(std::time::SystemTime::now());
        // config.txt changed the cadence or the time since the file last decided (it can
        // only at a start): the period whose moment passed is handled, as a save would do.
        {
            let _g = self.reports.settings_lock.lock();
            let mut f: ReportSchedule = self.reports.read_json(rsched::FILE);
            if rsched::reconcile(&mut f, crate::settings::get(), clock) {
                if let Err(err) = self.reports.write_json(rsched::FILE, &f) {
                    tracing::warn!(error = %err, "volume report: the schedule could not be brought in line with config.txt; not sending, to avoid a late send");
                    return None;
                }
                tracing::info!(schedule = ?f.seen_schedule, at = f.seen_at.as_deref().unwrap_or(""), "volume report: config.txt changed the schedule; a period whose moment has passed counts as handled");
            }
        }
        // Stopped: nothing is marked, so the report goes out on the first tick after.
        if self.volume_stopped() {
            return None;
        }
        let (e, _) = self.report_schedule_effective();
        let collected = e.schedule != Cadence::Daily || self.report_daily_collected(&e, clock.local);
        let p = rsched::due(&e, clock, collected)?;
        let ids = self.report_schedule_clusters(&e);
        if ids.is_empty() {
            return None;
        }
        // Remembered before the job runs: a send that brings the process down must not be
        // repeated by every restart.
        {
            let _g = self.reports.settings_lock.lock();
            let mut f: ReportSchedule = self.reports.read_json(rsched::FILE);
            f.last_period = Some(rsched::period_key(&p));
            if let Err(err) = self.reports.write_json(rsched::FILE, &f) {
                tracing::warn!(error = %err, "volume report: the schedule could not be marked; not sending, to avoid sending twice");
                return None;
            }
        }
        tracing::info!(period = %p.label, clusters = ids.len(), "volume report: the mailed report is due");
        self.report_queue_mailed(ids, p, &e, SCHEDULE_BY).ok()
    }
}

const MAIL_FOOTER: &str = "The attachment has the period's days, months and breakdowns. Sizes are 1024-based \
(GB = 1024³ bytes); \"not measured\" marks a figure Elasticsearch could not report, and the breakdown's \
primary size per value is an estimate (est.).\n";
