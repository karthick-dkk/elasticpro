//! The core's side of docs/HEALTH.md: the minute task, `SYSTEM_HEALTH`, and the level `PING`
//! carries. The samplers, the ring, the histograms and the checks are `crate::health`, pure and
//! tested; this file only gathers what the core already holds and hands it to them.
//!
//! Nothing here sends a cluster anything: every figure is the core's own state, the worker's
//! status file, or the data volume.

use super::{Caller, Core};
use crate::health::{self, Check, CheckInputs, Level, PollerFigures, UpstreamRec, WorkerStatus, WorkerView};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// A finished request, copied out of the request log: cluster, started (ms), took, status, reached the cluster.
type Finished = (String, u64, Option<u64>, Option<String>, bool);

/// The core's request-record outcomes that never reached the cluster.
const NOT_SENT: &[&str] = &["overloaded", "queue_timeout", "aborted", "client_gone"];

impl Core {
    /// The minute task: once now, then every minute. Started by the bridge binary, never by
    /// `Core::new` (a timer that started itself would run in every test).
    pub fn start_health(self: &Arc<Self>) {
        if self.health.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(core) = weak.upgrade() else { break };
                core.health_sample().await;
                drop(core);
                tokio::time::sleep(std::time::Duration::from_secs(health::SAMPLE_EVERY_SECS)).await;
            }
        });
    }

    /// One sample, off the runtime's workers (it reads files and may walk the data volume).
    pub async fn health_sample(self: &Arc<Self>) {
        let core = self.clone();
        let _ = tokio::task::spawn_blocking(move || core.health_sample_now(crate::fleet::now_ms())).await;
    }

    fn health_sample_now(&self, now: u64) {
        let n = self.health.samples.fetch_add(1, Ordering::SeqCst);
        let worker = self.health_worker(now);
        let own_p95 = self.health.times.lock().window(1, now).own.p95_ms;
        let load = self.gate.load();
        let minute = self.gate.window(health::MINUTE_MS);
        let reports_conc = self.health_jobs(&worker).0.iter().filter_map(|j| j.concurrency).reduce(|a, b| a + b);
        let ring_json = {
            let mut m = self.health.monitor.lock();
            m.read(now);
            let mut s = m.sample();
            s.p95_ms = own_p95;
            s.waiting = Some(load.queued.iter().sum::<usize>() as u64);
            s.overloaded = Some(minute.overloaded as u64);
            s.queue_timeout = Some(minute.queue_timeout as u64);
            if let Some(st) = worker.status.as_ref().filter(|_| worker.state == "up" || worker.state == "late") {
                s.worker_rss = st.memory.rss_bytes;
            }
            s.worker_conc = worker.status.as_ref().and_then(WorkerStatus::concurrency).or(reports_conc);
            m.push(s);
            (n + 1).is_multiple_of(health::PERSIST_EVERY_SAMPLES).then(|| m.ring.to_json(self.health.role))
        };
        if let (Some(body), Some(d)) = (ring_json, self.data_dir.as_deref()) {
            if let Err(e) = crate::volume::store::write_atomic(&health::Ring::path(d, self.health.role), &body) {
                tracing::warn!(error = %e, "health: the day's samples could not be written");
            }
        }
        // The volume: its space every minute (one statvfs), its areas every ten (a walk).
        let disk = self.data_dir.as_deref().map(|d| {
            let mut fig = health::disk_space(d);
            let before = self.health.held.read().disk.clone();
            if n.is_multiple_of(health::DISK_EVERY_SAMPLES) || before.as_ref().is_none_or(|b| b.areas.is_empty()) {
                fig.areas = health::disk_areas(d);
                fig.areas_at = Some(now);
            } else if let Some(b) = before {
                fig.areas = b.areas;
                fig.areas_at = b.areas_at;
            }
            fig
        });
        let schedules = match self.data_dir.as_deref() {
            Some(d) => {
                let read = |f: &str| std::fs::read(d.join(f)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
                let file = read(crate::report::schedule::FILE).unwrap_or(Value::Null);
                let state = read(crate::report::schedule::STATE_FILE);
                health::schedules_from(&file, state.as_ref(), crate::report::schedule::Clock::now())
            }
            None => vec![],
        };
        let mail_file: crate::report::mail::MailFile = self.reports.read_json(crate::report::mail::FILE);
        let mail_configured = self.data_dir.is_some().then(|| crate::report::mail::effective(&mail_file, crate::settings::get()).configured());
        {
            let mut h = self.health.held.write();
            h.disk = disk;
            h.schedules = schedules;
            h.mail_configured = mail_configured;
        }
        let checks = self.health_checks(now, &worker, None);
        self.health.set_level(health::overall(&checks));
        self.health.held.write().checks = checks;
    }

    /// The worker as the tab shows it, from its status file.
    fn health_worker(&self, now: u64) -> WorkerView {
        let file = match self.data_dir.as_deref() {
            Some(d) => WorkerStatus::read(d),
            None => Ok(None),
        };
        health::worker_view(self.health.role, file, now, crate::VERSION)
    }

    /// Running and queued report jobs: the worker's own list when it reports one (it has the
    /// concurrency), else the queue this process holds (role all) or `jobs.json` (role core).
    fn health_jobs(&self, worker: &WorkerView) -> (Vec<health::JobLine>, Vec<health::JobLine>, &'static str) {
        // Role core: `jobs.json` as the worker last wrote it; else the queue held here.
        let queue: Value = serde_json::to_value(self.reports.snapshot()).unwrap_or(Value::Null);
        let (running, queued) = health::jobs_from(&queue);
        match worker.status.as_ref().filter(|s| !s.jobs.is_empty()) {
            Some(s) => (s.jobs.clone(), queued, "worker"),
            None => (running, queued, if self.health.role == "core" { "jobs.json" } else { "core" }),
        }
    }

    fn health_poller(&self, now: u64) -> PollerFigures {
        use crate::fleet::catalogue::Class as Ds;
        use crate::fleet::entry::ReachState;
        let enabled = self.fleet_enabled();
        let cfg = self.fleet.cfg.read().clone();
        let ids: Vec<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        let n = ids.len();
        let known: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let (next_due, down) = {
            let st = self.fleet.state.lock();
            let idle = st.idle(now);
            let down = ids.iter().filter(|c| st.reach_state(c) == ReachState::Unreachable).count() as u64;
            let due: Vec<Option<u64>> = st.entries.iter().filter_map(|(key, e)| {
                let (cluster, ds) = (key.0.as_str(), key.1);
                if !known.contains(cluster) || st.reach_state(cluster) == ReachState::Unreachable
                    || st.throttle.get(cluster).is_some_and(|t| t.until > now)
                    || cfg.effective_class(ds, n) != Ds::Background
                    || (idle && ds != crate::fleet::catalogue::Dataset::Health) {
                    return None;
                }
                // Being fetched right now: counted, not due.
                Some(if st.inflight.contains_key(key) { None } else { e.next_due })
            }).collect();
            (due, down)
        };
        let (tracked, due, late, by) = health::lateness(&next_due, now);
        let (cycle_ms, cycle_p95_ms) = self.health.cycle();
        PollerFigures {
            enabled, stopped: cfg.stopped(now), clusters: n as u64, down, tracked, due, late,
            late_pct: (tracked > 0).then(|| late as f64 * 100.0 / tracked as f64), late_by_max_ms: by,
            cycle_ms, cycle_p95_ms,
        }
    }

    /// The checks, from what is held and the figures of now. `poller`: already worked out by
    /// the caller, else worked out here.
    fn health_checks(&self, now: u64, worker: &WorkerView, poller: Option<&PollerFigures>) -> Vec<Check> {
        let (mem, cpu) = self.health.monitor.lock().figures();
        let w5 = self.health.times.lock().window(5, now);
        let refused = self.gate.window(crate::gate::STATS_WINDOW_MS);
        let own_poller;
        let poller = match poller {
            Some(p) => p,
            None => {
                own_poller = self.health_poller(now);
                &own_poller
            }
        };
        let held = self.health.held.read();
        health::evaluate(&CheckInputs {
            core_mem: &mem,
            core_cpu: &cpu,
            worker,
            message_p95_ms: w5.own.p95_ms,
            message_count: w5.own.count,
            refused_5m: Some((refused.overloaded + refused.queue_timeout) as u64),
            poller: Some(poller),
            disk: held.disk.as_ref(),
        })
    }

    /// The status strip of docs/HEALTH.md "What it shows", 1: one chip per part.
    fn health_parts(&self, now: u64, worker: &WorkerView, checks: &[Check]) -> Vec<Value> {
        let chip = |id: &str, label: &str, level: Level, text: String, at: Option<u64>| json!({ "id": id, "label": label, "level": level, "text": text, "at": at });
        let core_level = health::overall(&checks.iter().filter(|c| !c.id.starts_with("worker.")).cloned().collect::<Vec<_>>());
        let mut out = vec![chip("core", "Core", core_level,
            format!("{} · up {}", crate::VERSION, health::secs_text(self.started.elapsed().as_secs())), Some(self.health.started_at))];
        out.push(chip("worker", "Report worker", worker.level, worker.text.clone(), worker.status.as_ref().map(|s| s.heartbeat_at)));
        #[cfg(feature = "bridge")]
        {
            let (configured, ok, err) = self.fleet.redis_store().health();
            let newest_err = err.filter(|e| ok.is_none_or(|o| e.0 >= o));
            out.push(match (configured, ok, newest_err) {
                (false, _, _) => chip("redis", "Redis", Level::Off, "not configured — the fleet cache runs on memory and disk".into(), None),
                (true, _, Some((at, e))) => chip("redis", "Redis", Level::Bad, format!("down — {e}"), Some(at)),
                (true, Some(at), None) => chip("redis", "Redis", Level::Ok, "connected · last write".into(), Some(at)),
                (true, None, None) => chip("redis", "Redis", Level::Unknown, "not known — nothing written to it yet".into(), None),
            });
        }
        #[cfg(not(feature = "bridge"))]
        out.push(chip("redis", "Redis", Level::Off, "not in this build".into(), None));
        out.push(chip("database", "Database", Level::Unknown,
            "not known — the core does not connect to it (the db container has its own healthcheck)".into(), None));
        // Zabbix sync.
        {
            let configured = self.edition == crate::auth::Edition::Hosted && self.zbx_api().configured();
            let z = self.zbx_sync.read();
            out.push(match (configured, &z.error, z.last_ok) {
                (false, _, _) => chip("zabbix", "Zabbix sync", Level::Off, "not configured".into(), None),
                (true, Some(e), last) => chip("zabbix", "Zabbix sync", Level::Warn, format!("last sync failed — {e}"), last.map(|s| s * 1000)),
                (true, None, Some(at)) => chip("zabbix", "Zabbix sync", Level::Ok, format!("last sync ok · {} cluster(s)", z.specs.len()), Some(at * 1000)),
                (true, None, None) => chip("zabbix", "Zabbix sync", Level::Unknown, "not known — no sync yet".into(), None),
            });
        }
        // Mail: the newest last send of any schedule.
        {
            let held = self.health.held.read();
            let last = held.schedules.iter().filter_map(|s| s.last_sent.clone())
                .max_by_key(|l| l.get("at").and_then(Value::as_i64).unwrap_or(0));
            out.push(match (held.mail_configured, last) {
                (None | Some(false), _) => chip("mail", "Mail", Level::Off, "not configured".into(), None),
                (Some(true), Some(l)) => {
                    let at = l.get("at").and_then(Value::as_u64);
                    if l.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                        chip("mail", "Mail", Level::Ok, "last send ok".into(), at)
                    } else {
                        chip("mail", "Mail", Level::Warn, format!("last send failed — {}", l.get("error").and_then(Value::as_str).unwrap_or("no reason given")), at)
                    }
                }
                (Some(true), None) => chip("mail", "Mail", Level::Unknown, "not known — configured, nothing sent yet".into(), None),
            });
        }
        // History store.
        {
            let s = self.history_store.stored.read();
            let st = self.history_store.status.lock();
            let failed_last = st.last_error_at.is_some_and(|e| st.last_success_at.is_none_or(|ok| e >= ok));
            out.push(if !s.configured() {
                chip("history", "History store", Level::Off, "not configured".into(), None)
            } else if !s.armed {
                chip("history", "History store", Level::Off, "configured, not armed — writes nothing".into(), None)
            } else if failed_last {
                chip("history", "History store", Level::Warn, format!("armed · last write failed — {}", st.last_error.clone().unwrap_or_default()), st.last_error_at)
            } else if let Some(at) = st.last_success_at {
                chip("history", "History store", Level::Ok, format!("armed · last write ok · {} documents since start", st.docs_written), Some(at))
            } else {
                chip("history", "History store", Level::Unknown, "armed · not known — nothing written yet".into(), None)
            });
        }
        let _ = now;
        out
    }

    /// `SYSTEM_HEALTH`: ElasticPro's own health, the worker's from its status file. Administrators
    /// only (auth.rs); per-cluster gate figures narrowed to the clusters the caller may see.
    pub(crate) async fn system_health(self: &Arc<Self>, caller: Option<&Caller>) -> Value {
        // Never read yet (the minute task is not running: a test, the desktop app): read once now.
        if self.health.monitor.lock().raw.is_none() {
            self.health_sample().await;
        }
        let now = crate::fleet::now_ms();
        let visible = self.visible_ids(caller);
        let worker = self.health_worker(now);
        let poller = self.health_poller(now);
        let checks = self.health_checks(now, &worker, Some(&poller));
        let level = health::overall(&checks);
        self.health.set_level(level);

        let (mem, cpu, hour, trend) = {
            let m = self.health.monitor.lock();
            let (mem, cpu) = m.figures();
            let hour = m.ring.refusals_within(now, 60 * health::MINUTE_MS);
            let trend: Vec<Value> = m.ring.within(now, health::DAY_MS)
                .map(|s| json!([s.t, s.rss, s.p95_ms, s.waiting, s.worker_rss, s.worker_conc])).collect();
            (mem, cpu, hour, trend)
        };
        let (w5, w60) = {
            let t = self.health.times.lock();
            (t.window(5, now), t.window(60, now))
        };
        // Copied out and the lock let go at once: every request to a cluster takes it.
        let recs: Vec<Finished> = {
            let log = self.requests.lock();
            log.recent.iter().rev()
                .take_while(|r| now.saturating_sub(r.started_at) <= 5 * health::MINUTE_MS + 120_000)
                .map(|r| (r.cluster.clone(), r.started_at, r.ms, r.status.clone(),
                          r.sent && !r.shared && !r.cached && !r.status.as_deref().is_some_and(|s| NOT_SENT.contains(&s))))
                .collect()
        };
        let ups: Vec<UpstreamRec<'_>> = recs.iter()
            .map(|r| UpstreamRec { cluster: &r.0, at_ms: r.1, ms: r.2, status: r.3.as_deref(), sent: r.4 }).collect();
        let gate = health::gate_figures("core", &self.gate, &ups, hour, visible.as_ref());

        let budget = crate::memory::budget();
        let (rc_entries, rc_bytes) = self.read_cache.usage();
        let cache_used = self.fleet.state.lock().total_cost() as u64;
        let cfg = self.req_cfg.read().clone();
        let memory_budget = json!({
            "limitSource": budget.limit_source,
            "warning": budget.warning,
            "cache": { "budgetBytes": budget.cache_bytes, "usedBytes": cache_used },
            "inflight": { "budgetBytes": self.body_budget.total_bytes(), "usedBytes": self.body_budget.in_use_bytes() },
            "readCache": { "budgetBytes": cfg.read_cache_bytes, "usedBytes": rc_bytes, "entries": rc_entries },
            // The reports share of this process's budget (memory.rs). What it holds is not
            // counted, so `usedBytes` is not known rather than a zero; in role core the reports
            // run in the worker, under the worker's own limit.
            "reports": { "budgetBytes": budget.reports_bytes, "usedBytes": Value::Null, "pageMaxBytes": budget.report_page_bytes(),
                         "holder": if self.role == crate::worker::Role::Core { "worker" } else { "this process" } },
        });

        let (running, queued, source) = self.health_jobs(&worker);
        let collection: Vec<Value> = match worker.status.as_ref() {
            Some(s) if !s.collection.is_empty() => s.collection.iter().map(|c| json!(c)).collect(),
            _ => self.volume.runs.lock().iter().filter(|(_, r)| r.running)
                .map(|(id, r)| json!({ "clusterId": id, "kind": "volume", "progress": { "done": r.done, "total": r.total }, "concurrency": Value::Null }))
                .collect(),
        };
        let held = self.health.held.read().clone();
        let last_job = {
            let q = self.reports.snapshot();
            let mut by_kind: std::collections::BTreeMap<String, Value> = Default::default();
            for j in q.jobs.iter().filter(|j| j.status.finished()) {
                let v = serde_json::to_value(j).unwrap_or(Value::Null);
                let kind = v.get("reportKind").and_then(Value::as_str).unwrap_or("volume").to_string();
                let newer = by_kind.get(&kind).and_then(|o| o.get("endedAt").and_then(Value::as_i64)).is_none_or(|t| j.ended_at.unwrap_or(0) >= t);
                if newer {
                    by_kind.insert(kind, json!({ "id": j.id, "status": v.get("status"), "endedAt": j.ended_at, "error": j.error, "cluster": j.cluster_name }));
                }
            }
            by_kind
        };
        let housekeeping = self.housekeeping.status(now);

        let parts = self.health_parts(now, &worker, &checks);
        json!({
            "ok": true,
            "at": now,
            "role": self.health.role,
            "level": level,
            "thresholds": health::THRESHOLDS,
            "checks": checks,
            "parts": parts,
            "core": {
                "version": crate::VERSION,
                "startedAt": self.health.started_at,
                "uptimeSec": self.started.elapsed().as_secs(),
                "memory": mem,
                "budget": memory_budget,
                "cpu": cpu,
                "messages": {
                    "w5m": w5, "w1h": w60,
                    "slowest": health::slowest(&w5, 5),
                    "sessions": self.sessions.count(),
                    "eventStreams": self.fleet_streams(),
                },
                "gate": gate,
                "poller": poller,
                "disk": held.disk,
                "lastPrune": housekeeping.get("lastRun").cloned().unwrap_or(Value::Null),
            },
            "worker": worker,
            "reports": {
                "source": source,
                "running": running,
                "queued": queued.len(),
                "queuedJobs": queued.into_iter().take(10).collect::<Vec<_>>(),
                "collection": collection,
                "schedules": held.schedules,
                "lastJob": last_job,
            },
            // One point a minute for the day: [t, core rss, p95 ms, gate waiting, worker rss, worker concurrency].
            "trends": { "fields": ["t", "rss", "p95Ms", "waiting", "workerRss", "workerConcurrency"], "points": trend },
        })
    }
}
