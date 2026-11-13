//! The core's side of docs/JOBS.md: `JOBS_LIST`, each job's next run and the process figures
//! beside them. The registry, the run log and every rule about who reads what are
//! `crate::jobs`, pure and tested; this file gathers what the core already holds.
//!
//! Nothing here sends a cluster anything.

use super::{Caller, Core};
use crate::health::{self, WorkerStatus};
use crate::jobs::{self, NextRun, Owner, Page};
use crate::worker::Role;
use serde_json::{json, Value};

/// A worker run still open while the worker's heartbeat is late: `stale: true`.
fn mark_stale(r: &mut Value, late: bool) {
    let open = matches!(r["status"].as_str(), Some("running" | "queued"));
    r["stale"] = json!(late && open && r["owner"] == json!("worker"));
}

impl Core {
    /// Wait until the run log's last change is on disk. Tests only.
    #[doc(hidden)]
    pub fn jobs_flush_for_tests(&self) {
        self.jobs.flush();
    }

    /// `JOBS_LIST {before?, limit?, jobId?}`: every job with its state, the runs newest first
    /// (a page), and the process figures already sampled. Any signed-in user above guest; a
    /// caller limited to some clusters reads only the runs about theirs (`jobs::run_view`,
    /// through the one per-caller view, `sink_view`).
    pub(crate) async fn jobs_list(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let p = match Page::parse(msg) {
            Ok(p) => p,
            Err(e) => return json!({ "ok": false, "kind": "bad_request", "message": e }),
        };
        let view = self.sink_view(caller);
        // Without accounts (portable) the one person is the administrator.
        let who = jobs::Reader { view: &view, admin: caller.is_none_or(|c| c.role >= crate::auth::Role::Admin) };
        let (mut runs, problems) = self.jobs.all_runs();
        // Report jobs: `jobs.json` is their record (the worker's queue, or the one held here).
        runs.extend(self.reports.snapshot().jobs.iter().map(|j| (Owner::Worker, jobs::from_report_job(j))));
        // Role core: a worker run still "running" while the worker's heartbeat is late (or
        // never came) may have ended with the worker — shown `stale: true`, never ended here.
        let stale = self.role == Role::Core && self.worker_heartbeat_late();
        let mut states = jobs::job_states(&runs, who);
        let controls = self.jobs.controls();
        // The governor (docs/JOBS.md "Governor"): its figures, and each running job's allocation.
        let (governor, mut allocations) = self.governor_for_list();
        let mut list = vec![];
        let created = self.created_job_entries(view.visible.as_ref(), who.admin);
        let entries = jobs::REGISTRY.iter().map(|d| (d.id.to_string(), d.to_json(), Some(d)))
            .chain(created.into_iter().map(|v| (v["id"].as_str().unwrap_or("").to_string(), v, None)));
        for (id, mut v, d) in entries.collect::<Vec<_>>() {
            let (mut current, active, last) = states.remove(&id).unwrap_or_default();
            if let Some(c) = current.as_mut() {
                mark_stale(c, stale);
            }
            let (next, why) = match d {
                Some(d) => self.job_next_run(d).await,
                None => self.created_next_send(&id),
            };
            let set = controls.job(&id);
            // Paused or off: no time — the note says why, and who paused it.
            let (next, why) = match controls.held(&id) {
                Some(h) if d.is_none_or(|d| d.kind == jobs::JobKind::Automatic) => (None, Some(h.text())),
                _ => (next, why),
            };
            v["state"] = json!({
                "enabled": set.enabled.unwrap_or(true), "paused": set.paused, "pausedBy": set.paused_by, "pausedAt": set.paused_at,
                "current": current, "activeRuns": active, "lastRun": last,
                "nextRunAt": next, "nextRunNote": why,
                "allocation": allocations.remove(&id),
            });
            list.push(v);
        }
        let (mut page, next) = jobs::page(runs, &p, who);
        for r in &mut page {
            mark_stale(r, stale);
        }
        // Busy clusters (docs/JOBS.md "Busy clusters"): the caller's only.
        let busy: Vec<Value> = self.busy_now().into_values().filter(|b| view.sees(&b.cluster))
            .map(|b| json!({ "cluster": b.cluster, "signal": b.signal, "reason": b.reason, "since": b.since })).collect();
        // A run log that could not be read is said (its runs are missing, not none); where it
        // is on disk is an administrator's.
        let problems: Vec<String> = if who.admin { problems } else { problems.iter().map(|_| "a run log could not be read".to_string()).collect() };
        json!({ "ok": true, "role": self.role.as_str(), "jobs": list, "runs": page, "next": next, "busy": busy,
                "governor": governor, "process": self.jobs_process(), "problems": problems })
    }

    /// Role core: the worker's heartbeat is late, down, or never came (its runs may be stale).
    fn worker_heartbeat_late(&self) -> bool {
        let Some(d) = self.data_dir.as_deref() else { return false };
        match WorkerStatus::read(d) {
            Ok(Some(st)) => health::heartbeat_late(st.heartbeat_at, crate::fleet::now_ms()),
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// When a job runs next (epoch ms), or `None` with why. Each is the job's own rule, read
    /// where that job keeps it (`jobs::NextRun`).
    async fn job_next_run(&self, d: &jobs::Descriptor) -> (Option<i64>, Option<String>) {
        let none = |why: &str| (None, Some(why.to_string()));
        let at = |t: Option<u64>| t.map(|t| t as i64);
        if d.kind == jobs::JobKind::Automatic && !self.edition().schedules() {
            return none("scheduled jobs run only in the hosted edition");
        }
        match d.next_run {
            NextRun::OnRequest => none("runs when a person asks"),
            NextRun::DelaySink => {
                let s = self.delay_sink.read();
                if !s.config.enabled {
                    return none("not armed (Config-Management › Data › Scheduled log delay)");
                }
                // Armed and never run here: the next minute's tick.
                (Some(s.state.next_due_at.unwrap_or_else(crate::delay_sink::now_ms)), None)
            }
            NextRun::Housekeeping => {
                if self.housekeeping.config().minutes == 0 {
                    return none("the timer is off (ELASTICPRO_HOUSEKEEPING_MINUTES=0)");
                }
                match self.housekeeping.next_run_at() {
                    Some(t) => (at(Some(t)), None),
                    None => none("the timer has not started in this process"),
                }
            }
            NextRun::Backup => {
                if !self.backup.keeps() {
                    return none("backups are kept only on a hosted server with a data directory");
                }
                let s = self.backup.schedule.read().clone();
                match s.next_run(crate::volume::schedule::local_now()).and_then(crate::volume::schedule::local_to_ms) {
                    Some(t) => (Some(t), None),
                    None => none("the backup schedule is off (Config-Management › Backup)"),
                }
            }
            NextRun::VolumeDaily => match self.volume_next_run_any().await {
                Ok(Some(t)) => (Some(t), None),
                Ok(None) => none("no cluster to collect, or no data directory"),
                Err(e) => (None, Some(format!("not known: {e}"))),
            },
            NextRun::HostsDaily => match self.hosts_next_at() {
                Some(t) => (Some(t), None),
                None => none("not known: the hosts schedule's time does not exist today (a clock change)"),
            },
            NextRun::MailedSchedule => {
                let kind = d.report.unwrap_or_default();
                match self.report_next_send_at(kind) {
                    Some(t) => (Some(t), None),
                    None => none("the mailed schedule is off or has no recipients (Reports › Exports)"),
                }
            }
            NextRun::EveryMinute => match self.history_writes_open() {
                Err(why) => (None, Some(why)),
                Ok(()) => none("within a minute whenever something is queued; no fixed time"),
            },
            NextRun::ZabbixSync => {
                if !self.zbx_api().configured() {
                    return none("the Zabbix API is not configured (Config → Zabbix)");
                }
                // The timer says when it wakes next, each time it goes to sleep — from the start,
                // so a restart has a time at once.
                match (self.role.serves_people(), self.jobs.next_at(jobs::ZABBIX_SYNC)) {
                    (false, _) => none("the core runs it"),
                    (true, Some(t)) => (at(Some(t)), None),
                    (true, None) => none("the timer has not started in this process"),
                }
            }
            NextRun::ZabbixPush => {
                let s = self.zbx_push.lock();
                match (s.enabled, s.next_at) {
                    (true, Some(t)) => (at(Some(t)), None),
                    (true, None) => none("not started yet"),
                    (false, _) => (None, Some(s.idle.clone().unwrap_or_else(|| "ZABBIX_METRICS_HOST is not set".into()))),
                }
            }
        }
    }

    /// The figures of docs/HEALTH.md this answer carries: CPU, memory and the gate of this
    /// process, and of the worker as its last heartbeat said. Anything not sampled is null.
    fn jobs_process(&self) -> Value {
        let (mem, cpu) = self.health.monitor.lock().figures();
        let load = self.gate.load();
        let own = json!({
            "role": self.role.as_str(),
            "cpuPct": cpu.pct_1m, "cpuOfLimitPct": cpu.pct_of_limit,
            "memoryBytes": mem.rss_bytes, "memoryLimitBytes": mem.limit_bytes, "memoryPct": mem.used_pct,
            "gate": { "running": load.running.iter().sum::<usize>(), "queued": load.queued.iter().sum::<usize>(),
                      "oldestWaitMs": load.oldest_wait_ms },
        });
        let worker = match self.role {
            Role::All => json!({ "state": "not_deployed", "text": "role all: this process runs the worker's jobs itself" }),
            _ => {
                let file = match self.data_dir.as_deref() {
                    Some(d) => WorkerStatus::read(d),
                    None => Ok(None),
                };
                let v = health::worker_view(self.role.as_str(), file, crate::fleet::now_ms(), crate::VERSION);
                let st = v.status.as_ref();
                let gate = st.and_then(|s| s.gate.as_ref()).map(|g| json!({
                    "running": g.classes.iter().map(|c| c.running).sum::<u64>(),
                    "queued": g.classes.iter().map(|c| c.waiting).sum::<u64>(),
                }));
                json!({
                    "state": v.state, "text": v.text, "heartbeatAt": st.map(|s| s.heartbeat_at),
                    "cpuPct": st.and_then(|s| s.cpu.pct_1m), "cpuOfLimitPct": st.and_then(|s| s.cpu.pct_of_limit),
                    "memoryBytes": st.and_then(|s| s.memory.rss_bytes), "memoryLimitBytes": st.and_then(|s| s.memory.limit_bytes),
                    "memoryPct": st.and_then(|s| s.memory.used_pct), "gate": gate,
                })
            }
        };
        json!({ "core": own, "worker": worker })
    }
}
