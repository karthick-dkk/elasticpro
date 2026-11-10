//! The job controls of docs/JOBS.md: `JOB_RUN`, `JOB_PAUSE`, `JOB_RESUME`, `JOB_CANCEL`,
//! `JOB_RETRY`, `JOB_CREATE`, `JOB_DELETE`, `JOB_SETTINGS_GET` / `JOB_SETTINGS_SET`, and the
//! per-cluster load view (busy clusters) the background work consults.
//!
//! Every one that changes something is an administrator's who sees every cluster (one limited
//! to some is refused: the jobs are fleet-wide). A run that writes to a cluster is refused when
//! `Writes::decide` blocks it — with the session unlock never counted, since a run is
//! background work and no background work holds it (guard.rs). The settings are the core's
//! file (`jobs::controls`), read by every timer; the worker's runs are started, cancelled and
//! retried by the worker, which the core asks over the internal HTTP (`/job`).

use super::{Caller, Core};
use crate::auth::Role;
use crate::jobs::{self, controls::Controls, load, Owner, RunMeta, RunStatus, Trigger};
use crate::worker::Role as ProcessRole;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Arc;

fn bad(kind: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "message": message.into() })
}

fn who(caller: Option<&Caller>) -> String {
    caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into())
}

impl Core {
    /// Every `JOB_*` message (`auth::required_role` has checked the role is admin).
    pub(crate) async fn job_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if self.edition.uses_accounts() && caller.is_none_or(|c| c.role < Role::Admin) {
            return bad("forbidden", "the job controls are for administrators");
        }
        if t != "JOB_SETTINGS_GET" && caller.is_some_and(Caller::limited) {
            return bad("forbidden", "the jobs are fleet-wide: an administrator limited to some clusters cannot change them");
        }
        match t {
            "JOB_RUN" => self.job_run(msg, caller).await,
            "JOB_PAUSE" | "JOB_RESUME" => self.job_pause(t == "JOB_PAUSE", msg, caller),
            "JOB_CANCEL" => self.job_cancel(msg, caller).await,
            "JOB_RETRY" => self.job_retry(msg, caller).await,
            "JOB_CREATE" => self.job_create(msg, caller).await,
            "JOB_DELETE" => self.job_delete(msg, caller),
            "JOB_SETTINGS_GET" => self.job_settings_get(),
            "JOB_SETTINGS_SET" => self.job_settings_set(msg, caller),
            _ => bad("bad_message", format!("Unknown message type {t:?}")),
        }
    }

    /// A job id the registry has, or a created schedule that exists.
    pub(crate) fn job_known(&self, id: &str) -> bool {
        jobs::descriptor(id).is_some() || (jobs::is_created_id(id) && self.reports.created_settings().get(id).is_some())
    }

    fn job_owner(&self, id: &str) -> Option<Owner> {
        jobs::descriptor(id).map(|d| d.owner).or_else(|| jobs::is_created_id(id).then_some(Owner::Worker))
    }

    fn job_id_of(msg: &Value) -> Result<String, Value> {
        msg.get("jobId").and_then(Value::as_str).map(String::from).ok_or_else(|| bad("bad_request", "jobId is required (see JOBS_LIST jobs[].id)"))
    }

    /* ------------------------------------------ JOB_RUN ------------------------------------------ */

    /// `JOB_RUN {jobId, clusterIds?}`: run now, `manual:<user>`. Answers with the run's id; a run
    /// already open is `already_running` with its id. Role core asks the worker for its jobs.
    async fn job_run(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let id = match Self::job_id_of(msg) {
            Ok(i) => i,
            Err(r) => return r,
        };
        if !self.job_known(&id) {
            return bad("not_found", format!("no job {id:?} (see JOBS_LIST jobs[].id)"));
        }
        if !jobs::on_demand(&id) {
            return bad("bad_request", if id == jobs::REPORT_RUN {
                "a report run names its clusters and dates: JOB_CREATE {once: true, …} (or REPORT_RUN)".to_string()
            } else {
                format!("{id} runs every minute by itself; there is nothing to run now")
            });
        }
        if self.role == ProcessRole::Core && self.job_owner(&id) == Some(Owner::Worker) {
            return self.forward_to_worker("JOB_RUN", msg, caller).await;
        }
        let trigger = Trigger::manual(&who(caller));
        self.job_run_local(&id, msg, caller, trigger, RunMeta::default()).await
    }

    /// Why a run of `job` may not write now, if it may not: the one job that writes to a
    /// monitored cluster is the log delay measurement, to its sink cluster. `Writes::decide`,
    /// told the run was asked for by hand and never that the guard is unlocked — a run holds
    /// no session's unlock, so a read-only config refuses it whatever the guard says.
    fn job_write_refusal(&self, job: &str) -> Option<Value> {
        if job != jobs::LOGDELAY_MEASURE || self.delay_sink.read().config.destination != crate::delay_sink::Destination::Cluster {
            return None;
        }
        let read_only = self.primed.read().read_only;
        (crate::guard::Writes::decide(read_only, false, true) == crate::guard::Writes::Blocked).then(|| bad("blocked_readonly",
            "the log delay measurement writes to its sink cluster and the config is read-only: set readOnly to false to let it write (the session's write unlock does not reach background work)"))
    }

    /// Begin a run for a person (`reserve`), answer its id, and let `work` — the job's own
    /// code, which adopts the run — do it in the background. A run `work` never adopted (it
    /// found nothing to do) ends `skipped`, saying `idle`.
    fn job_spawn<F, Fut>(self: &Arc<Self>, job: &str, name: &str, trigger: Trigger, meta: RunMeta, idle: &'static str, work: F) -> Value
    where
        F: FnOnce(Arc<Core>, Trigger) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let run_id = match self.jobs.reserve(job, trigger.clone(), vec![], meta, crate::fleet::now_ms()) {
            Ok(id) => id,
            Err(busy) => return busy.answer(name),
        };
        let core = self.clone();
        let (job_s, rid) = (job.to_string(), run_id.clone());
        tokio::spawn(async move {
            work(core.clone(), trigger).await;
            core.jobs.release(&job_s, &rid, idle);
        });
        json!({ "ok": true, "jobId": job, "runId": run_id, "started": true })
    }

    /// Run `job` here, started by `trigger` (`manual:<user>`, or `retry` with `meta`).
    pub(crate) async fn job_run_local(self: &Arc<Self>, job: &str, msg: &Value, caller: Option<&Caller>, trigger: Trigger, meta: RunMeta) -> Value {
        if let Some(r) = self.job_write_refusal(job) {
            return r;
        }
        let by = who(caller);
        let collection = |mut v: Value| {
            v["jobId"] = json!(job);
            // Nothing started and something already collecting: that run is the answer.
            let none = v["started"].as_array().is_some_and(Vec::is_empty);
            if v["ok"] == json!(true) && none && v["already"].as_array().is_some_and(|a| !a.is_empty()) {
                v["ok"] = json!(false);
                v["kind"] = json!("already_running");
                v["message"] = json!(format!("{job} is already running (run {}): wait for it to end", v["runId"].as_str().unwrap_or("?")));
            }
            v
        };
        match job {
            jobs::LOGDELAY_MEASURE => {
                if !self.edition.schedules() {
                    return bad("unsupported", "the scheduled log delay measurement runs only in the hosted edition");
                }
                self.job_spawn(job, "the scheduled log delay measurement", trigger, meta, "nothing to do", |core, t| async move {
                    core.run_delay_sink(t).await;
                })
            }
            jobs::HOUSEKEEPING => {
                let caller = caller.cloned().unwrap_or(Caller { name: by.clone(), role: Role::Admin, must_change: false, scope: None, play: None });
                let req = crate::housekeeping::RunRequest {
                    trigger: crate::housekeeping::Trigger::Manual, dry_run: msg.get("dryRun").and_then(Value::as_bool).unwrap_or(false),
                    by: Some(caller), protect_session: None, now: crate::fleet::now_ms(),
                };
                self.job_spawn(job, "housekeeping", trigger, meta, "housekeeping was already running", |core, _| async move {
                    core.housekeeping_run(req).await;
                })
            }
            jobs::SETTINGS_BACKUP => {
                if !self.backup.keeps() {
                    return bad("unsupported", "backups are kept only on a hosted server with a data directory");
                }
                self.job_spawn(job, "a settings backup", trigger, meta, "nothing to do", move |core, t| async move {
                    core.backup_run_now(t, &by).await;
                })
            }
            jobs::ZABBIX_SYNC => {
                if !self.zbx_api().configured() {
                    return bad("not_configured", "the Zabbix API is not configured (Config → Zabbix)");
                }
                self.job_spawn(job, "a Zabbix sync", trigger, meta, "nothing to do", |core, t| async move {
                    core.zabbix_sync_after_open(t, super::ZBX_SYNC_WAIT_PERSON).await;
                })
            }
            jobs::HISTORY_MIRROR => {
                if let Err(why) = self.history_writes_open() {
                    return bad("not_configured", why);
                }
                self.job_spawn(job, "the history store mirror", trigger, meta, "nothing was queued for the history store", |core, t| async move {
                    core.history_tick_as(t).await;
                })
            }
            jobs::VOLUME_DAILY => collection(self.volume_run_now(msg, caller, trigger, meta).await),
            jobs::HOSTS_COLLECT => collection(self.hosts_run_now(msg, caller, trigger, meta).await),
            _ => {
                if let Some(d) = jobs::descriptor(job).filter(|d| d.report.is_some()) {
                    let kind = d.report.unwrap_or_default();
                    let mut v = self.report_send_now(kind, &json!({ "kind": kind.as_str() }), caller);
                    v["jobId"] = json!(job);
                    return v;
                }
                if jobs::is_created_id(job) {
                    let mut v = self.report_send_now_created(job, caller);
                    v["jobId"] = json!(job);
                    return v;
                }
                bad("bad_request", format!("{job} cannot be run now"))
            }
        }
    }

    /* ------------------------------------- JOB_PAUSE / JOB_RESUME ------------------------------------- */

    /// `JOB_PAUSE {jobId}` / `JOB_RESUME {jobId}`: the timer starts no new run of a paused job
    /// (and records none); a run already going finishes. Kept in `controls.json`, which every
    /// timer reads before every run — the worker's too — so it survives a restart.
    fn job_pause(&self, pause: bool, msg: &Value, caller: Option<&Caller>) -> Value {
        let id = match Self::job_id_of(msg) {
            Ok(i) => i,
            Err(r) => return r,
        };
        if !self.job_known(&id) {
            return bad("not_found", format!("no job {id:?} (see JOBS_LIST jobs[].id)"));
        }
        if jobs::descriptor(&id).is_some_and(|d| !d.pausable) {
            return bad("bad_request", format!("{id} has no timer to pause: stop a run with JOB_CANCEL"));
        }
        let by = who(caller);
        let now = crate::fleet::now_ms();
        let res = self.jobs.update_controls(&by, |c| {
            if pause {
                c.pause(&id, &by, now);
            } else {
                c.resume(&id);
            }
            Ok(())
        });
        match res {
            Ok(((), c)) => {
                tracing::info!(target: "audit", user = %by, job = %id, paused = pause, "job: {}", if pause { "paused" } else { "resumed" });
                json!({ "ok": true, "jobId": id, "paused": pause, "settings": c.job_view(&id) })
            }
            Err(e) => bad("io_error", e),
        }
    }

    /* ------------------------------------------ JOB_CANCEL ------------------------------------------ */

    /// Find a run by id: this process's, the other process's file, or a report job.
    fn job_find_run(&self, id: &str) -> Option<(Owner, jobs::RunRecord)> {
        if let Some(rid) = id.strip_prefix("report-") {
            return self.reports.snapshot().get(rid).map(|j| (Owner::Worker, jobs::from_report_job(j)));
        }
        self.jobs.all_runs().0.into_iter().find(|(_, r)| r.id == id)
    }

    /// `JOB_CANCEL {runId}`: a queued run (a report job) ends `cancelled` at once; a running one
    /// is asked, and stops at its next safe point (between days, pages or clusters). The ask is
    /// kept in the run's file, so a restart ends it `cancelled`.
    async fn job_cancel(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(id) = msg.get("runId").and_then(Value::as_str).map(String::from) else { return bad("bad_request", "runId is required") };
        let by = who(caller);
        if let Some(rid) = id.strip_prefix("report-") {
            if self.role == ProcessRole::Core {
                return self.forward_to_worker("JOB_CANCEL", msg, caller).await;
            }
            let out = self.report_stop(&json!({ "id": rid }), caller);
            if out["ok"] != json!(true) {
                return out;
            }
            let has = |k: &str| out[k].as_array().is_some_and(|a| a.iter().any(|x| x == rid));
            return if has("stopped") {
                json!({ "ok": true, "runId": id, "status": "cancelled", "message": "it was queued: cancelled at once" })
            } else if has("stopping") {
                json!({ "ok": true, "runId": id, "cancelAsked": true, "message": "it stops at its next safe point (between days)" })
            } else {
                bad("bad_request", format!("{id} has already ended"))
            };
        }
        if self.jobs.cancel(&id, &by) {
            return json!({ "ok": true, "runId": id, "cancelAsked": true, "message": "it stops at its next safe point" });
        }
        match self.job_find_run(&id) {
            Some((Owner::Worker, r)) if !r.status.finished() && self.role == ProcessRole::Core => {
                self.forward_to_worker("JOB_CANCEL", msg, caller).await
            }
            Some((_, r)) if r.status.finished() => bad("bad_request", format!("{id} has already ended ({})", serde_json::to_value(r.status).unwrap_or_default().as_str().unwrap_or(""))),
            Some(_) => bad("bad_request", format!("{id} is not running in this process any more")),
            None => bad("not_found", format!("no run {id:?}")),
        }
    }

    /* ------------------------------------------ JOB_RETRY ------------------------------------------ */

    /// `JOB_RETRY {runId}`: a failed, deferred or cancelled run again, with the same parameters
    /// (its clusters; a report job's clusters, dates, format and mail), `trigger: retry`, within
    /// the retry policy (`jobs::retry_refusal`).
    async fn job_retry(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(id) = msg.get("runId").and_then(Value::as_str).map(String::from) else { return bad("bad_request", "runId is required") };
        let policy = self.jobs.controls().overall;
        if let Some(rid) = id.strip_prefix("report-") {
            if self.role == ProcessRole::Core {
                return self.forward_to_worker("JOB_RETRY", msg, caller).await;
            }
            return self.report_retry(rid, caller, &policy);
        }
        let Some((owner, r)) = self.job_find_run(&id) else { return bad("not_found", format!("no run {id:?}")) };
        if owner == Owner::Worker && self.role == ProcessRole::Core {
            return self.forward_to_worker("JOB_RETRY", msg, caller).await;
        }
        if !matches!(r.status, RunStatus::Failed | RunStatus::Deferred | RunStatus::Cancelled) {
            return bad("bad_request", format!("only a failed, deferred or cancelled run is tried again; {id} is {}",
                                              serde_json::to_value(r.status).unwrap_or_default().as_str().unwrap_or("")));
        }
        if !jobs::on_demand(&r.job_id) {
            return bad("bad_request", format!("{} runs every minute by itself; its next run is the retry", r.job_id));
        }
        if let Some(refused) = jobs::retry_refusal(r.attempt, r.ended_at, &policy, crate::fleet::now_ms()) {
            return refused;
        }
        let meta = RunMeta { retry_of: Some(r.id.clone()), attempt: r.attempt + 1 };
        let m = if matches!(r.job_id.as_str(), jobs::VOLUME_DAILY | jobs::HOSTS_COLLECT) { json!({ "clusterIds": r.clusters }) } else { json!({}) };
        let mut out = self.job_run_local(&r.job_id, &m, caller, Trigger::Retry, meta).await;
        if out["ok"] == json!(true) {
            out["retryOf"] = json!(id);
            tracing::info!(target: "audit", user = %who(caller), job = %r.job_id, retry_of = %id, "job: retried");
        }
        out
    }

    /* ------------------------------------- JOB_CREATE / JOB_DELETE ------------------------------------- */

    /// `JOB_CREATE {report, once: true, clusterIds, period, format?, mail?, collectAgain?}`: one
    /// report run now (as `REPORT_RUN`; the same report already queued or running is joined).
    /// `JOB_CREATE {report, name, clusters, schedule, at, to, …}`: a schedule of its own, a job
    /// of its own (`report.schedule.<id>`), beside the built-in schedule of its kind.
    async fn job_create(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        if msg.get("once").and_then(Value::as_bool) == Some(true) {
            let Some(kind) = msg.get("report").and_then(Value::as_str).and_then(crate::report::jobs::ReportKind::parse) else {
                return bad("bad_request", "report must be volume, indices, hosts or log_delay");
            };
            let mut m = msg.clone();
            m["type"] = json!("REPORT_RUN");
            m["kind"] = json!(kind.as_str());
            let mut out = self.report_msg("REPORT_RUN", &m, caller).await;
            if out["ok"] == json!(true) {
                let ids: Vec<String> = out["jobs"].as_array().into_iter().flatten()
                    .filter_map(|j| j["id"].as_str()).map(|i| format!("report-{i}")).collect();
                out["runIds"] = json!(ids);
            }
            return out;
        }
        if !self.edition.schedules() {
            return bad("unsupported", "report schedules run only in the hosted edition");
        }
        let (name, kind, mut s) = match crate::report::created::parse(msg, |id| self.spec_for(id).is_some()) {
            Ok(x) => x,
            Err(e) => return bad("bad_request", e),
        };
        let by = who(caller);
        let now = crate::fleet::now_ms() as i64;
        // The period whose moment has passed already counts as handled, as a save of the
        // built-in schedule decides: a schedule made at 09:00 for 07:00 sends tomorrow.
        let mut tmp = s.clone();
        tmp.last_period = None;
        crate::report::schedule::mark_passed(&mut tmp, crate::report::schedule::Clock::now());
        s.mark_passed = tmp.last_period;
        s.set_by = Some(by.clone());
        s.set_at = Some(now);
        let mut file = self.reports.created_settings();
        if file.schedules.len() >= crate::report::created::MAX {
            return bad("bad_request", format!("at most {} created schedules: delete one first (JOB_DELETE)", crate::report::created::MAX));
        }
        if file.schedules.iter().any(|c| c.name.eq_ignore_ascii_case(&name)) {
            return bad("name_taken", format!("a schedule is already named {name:?}"));
        }
        let c = crate::report::created::Created { id: crate::auth::random_hex(6), name, report: kind, created_by: by.clone(), created_at: now, schedule: s };
        let job_id = c.job_id();
        file.version = 1;
        file.schedules.push(c);
        if let Err(e) = self.reports.write_created(&file) {
            return bad("io_error", e);
        }
        tracing::info!(target: "audit", user = %by, job = %job_id, report = kind.as_str(), "report schedule created");
        json!({ "ok": true, "jobId": job_id, "job": self.created_job_entries(None, true).into_iter().find(|j| j["id"] == json!(job_id)) })
    }

    /// `JOB_DELETE {jobId}`: a created schedule goes (with its settings). A built-in job cannot.
    fn job_delete(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let id = match Self::job_id_of(msg) {
            Ok(i) => i,
            Err(r) => return r,
        };
        if !jobs::is_created_id(&id) {
            return bad("bad_request", format!("{id} is built in: pause it (JOB_PAUSE) or switch its automatic runs off (JOB_SETTINGS_SET)"));
        }
        let mut file = self.reports.created_settings();
        let before = file.schedules.len();
        file.schedules.retain(|c| c.job_id() != id);
        if file.schedules.len() == before {
            return bad("not_found", format!("no created schedule {id:?}"));
        }
        if let Err(e) = self.reports.write_created(&file) {
            return bad("io_error", e);
        }
        let by = who(caller);
        let _ = self.jobs.update_controls(&by, |c| {
            c.jobs.remove(&id);
            Ok(())
        });
        tracing::info!(target: "audit", user = %by, job = %id, "report schedule deleted");
        json!({ "ok": true, "jobId": id, "deleted": true })
    }

    /// The created schedules as `JOBS_LIST` entries (without `state`). `visible`: the caller's
    /// clusters (`None` every one); a schedule is listed to whoever sees every cluster it names
    /// (one on every cluster, to an administrator who sees every one), its recipients to
    /// administrators only.
    pub(crate) fn created_job_entries(&self, visible: Option<&std::collections::HashSet<String>>, admin: bool) -> Vec<Value> {
        self.reports.created_view().into_iter().filter_map(|(c, e)| {
            let covered = e.cluster_ids();
            if !crate::report::jobs::may_read(visible, admin, covered.as_deref()) {
                return None;
            }
            let base = jobs::created_descriptor_defaults();
            let mut v = json!({
                "id": c.job_id(), "name": c.name, "kind": "automatic", "owner": "worker",
                "schedule": crate::report::created::describe(&e), "nextRun": base.next_run, "priority": base.priority,
                "pausable": true, "requests": base.requests, "report": c.report.as_str(), "detailsFor": "user", "clusterScoped": true,
                "created": { "by": c.created_by, "at": c.created_at, "clusters": e.clusters, "cadence": e.schedule, "at": e.at,
                             "period": e.period, "enabled": e.enabled, "lastSent": e.last_sent },
            });
            if admin {
                v["created"]["to"] = json!(e.to);
                v["created"]["cc"] = json!(e.cc);
                v["created"]["bcc"] = json!(e.bcc);
                v["created"]["subject"] = json!(e.subject);
            }
            Some(v)
        }).collect()
    }

    /// When a created schedule next sends, epoch ms, or why not.
    pub(crate) fn created_next_send(&self, id: &str) -> (Option<i64>, Option<String>) {
        let Some((_, e)) = self.reports.created_view().into_iter().find(|(c, _)| c.job_id() == id) else { return (None, Some("not found".into())) };
        match crate::report::schedule::next_send(&e, crate::report::schedule::Clock::now()).and_then(crate::volume::schedule::local_to_ms) {
            Some(t) => (Some(t), None),
            None => (None, Some("the schedule is off".into())),
        }
    }

    /* ------------------------------------------ settings ------------------------------------------ */

    fn job_settings_view(&self, c: &Controls) -> Value {
        let mut ids: Vec<String> = jobs::REGISTRY.iter().map(|d| d.id.to_string()).collect();
        ids.extend(self.reports.created_settings().schedules.iter().map(|x| x.job_id()));
        json!({ "ok": true, "overall": c.overall, "jobs": ids.iter().map(|id| c.job_view(id)).collect::<Vec<_>>(),
                "setBy": c.set_by, "setAt": c.set_at,
                "note": "requests, priority, auto and the CPU / memory thresholds are kept for the adaptive concurrency governor; pause, enabled and the retry policy act now" })
    }

    /// `JOB_SETTINGS_GET`: every job's settings (the registry's defaults filled in) and the overall ones.
    fn job_settings_get(&self) -> Value {
        self.job_settings_view(&self.jobs.controls())
    }

    /// `JOB_SETTINGS_SET {jobId?, enabled?, auto?, requests?: {min?, max?}, priority?, overall?: {…}}`.
    fn job_settings_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let by = who(caller);
        match self.jobs.update_controls(&by, |c| c.apply(msg, |id| self.job_known(id))) {
            Ok(((), c)) => {
                let job = msg.get("jobId").and_then(Value::as_str).unwrap_or("(overall)");
                tracing::info!(target: "audit", user = %by, job = %job, "job settings saved");
                self.job_settings_view(&c)
            }
            Err(e) => bad("bad_request", e),
        }
    }

    /* ------------------------------------------ busy clusters ------------------------------------------ */

    /// Every busy cluster now (`jobs::load::busy`, the one definition): the poller's signals
    /// (the core's), this process's own, and the other process's as it last published them.
    pub(crate) fn busy_now(&self) -> std::collections::BTreeMap<String, load::Busy> {
        let now = crate::fleet::now_ms();
        let mut others = self.load.own_busy(now);
        if let Some(d) = self.data_dir.as_deref() {
            match self.role {
                ProcessRole::Worker => {
                    if let Ok(Some(p)) = crate::worker::read_json_retry::<load::Published>(&d.join(jobs::DIR).join(load::PUBLISHED)) {
                        if now.saturating_sub(p.at) <= load::PUBLISHED_FRESH_MS {
                            others.extend(p.busy);
                        }
                    }
                }
                ProcessRole::Core => {
                    if let Ok(Some(st)) = crate::health::WorkerStatus::read(d) {
                        if !crate::health::heartbeat_late(st.heartbeat_at, now) {
                            others.extend(st.busy);
                        }
                    }
                }
                ProcessRole::All => {}
            }
        }
        let st = self.fleet.state.lock();
        load::busy(&st.slowed, &st.throttle, &others, now)
    }

    /// Whether background work should leave `cluster` alone now, and why.
    pub(crate) fn cluster_busy(&self, cluster: &str) -> Option<load::Busy> {
        self.busy_now().remove(cluster)
    }

    /// Role core: the busy clusters for the worker (`<data>/job-runs/busy.json`), each minute.
    pub(crate) fn publish_busy(&self, now: u64) {
        if self.role != ProcessRole::Core {
            return;
        }
        let Some(d) = self.data_dir.as_deref() else { return };
        let own = self.load.own_busy(now);
        let busy: Vec<load::Busy> = {
            let st = self.fleet.state.lock();
            load::busy(&st.slowed, &st.throttle, &own, now).into_values().collect()
        };
        let body = serde_json::to_vec(&load::Published { at: now, busy }).unwrap_or_default();
        if let Err(e) = crate::volume::store::write_atomic(&d.join(jobs::DIR).join(load::PUBLISHED), &body) {
            tracing::warn!(error = %e, "jobs: the busy clusters could not be published for the worker");
        }
    }

    /// Forget a cluster's own load signals. Tests only (a 429's hold is a minute).
    #[doc(hidden)]
    pub fn load_clear_for_tests(&self, cluster: &str) {
        self.load.clear(cluster);
    }
}
