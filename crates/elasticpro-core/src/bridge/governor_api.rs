//! The core's side of the governor (docs/JOBS.md "Governor"; the rule is `jobs::governor`, pure
//! and tested): the lanes a job's work runs in, the tick that measures and decides every ten
//! seconds, the core's publication of people waiting for the worker, the core's gate limits from
//! `JOB_SETTINGS_SET`, and the governor as `JOBS_LIST` shows it.
//!
//! Who does what:
//!
//! * role `worker` and `all` tick: they run the jobs the rule moves. In role `worker` the tick also
//!   sizes the worker's own gate (`Gate::set_limits`); in role `all` the gate is the one people use,
//!   so only the lanes hold the jobs back.
//! * role `core` writes `<data>/job-runs/core-load.json` every five seconds — people waiting at its
//!   gate — which the worker reads at its tick: one writer, read within ten seconds.
//! * the core's own jobs (log delay, history store) run in lanes fixed at their maximum.
//!
//! Nothing here sends a cluster anything.

use super::Core;
use crate::jobs::governor::{self, Change, CoreLoad, LaneGuard, Signals, View};
use crate::jobs::{self, controls::Controls};
use crate::worker::Role;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Arc;

/// The gate fields config.txt (or the environment it sets) manages.
pub(crate) fn gate_locked(key: &str) -> bool {
    crate::settings::get().manages(key) || std::env::var(format!("ELASTICPRO_{key}")).is_ok_and(|v| !v.trim().is_empty())
}

impl Core {
    /// The lane of the run `key` of `job_id`: made when the run's first part starts, gone when its
    /// last part ends.
    pub(crate) fn job_lane(&self, key: &str, job_id: &str) -> LaneGuard {
        let g = self.governor.lane(key, job_id, &self.jobs.controls(), crate::fleet::now_ms());
        if !g.lane().fixed && self.role.runs_batch() {
            // Its share now, not at the next tick.
            self.governor_share(&self.jobs.controls());
        }
        g
    }

    /// Run `f` as part of the run `key` of `job_id`: every request it sends waits in the run's lane.
    pub(crate) async fn governed<F: Future>(&self, key: &str, job_id: &str, f: F) -> F::Output {
        let g = self.job_lane(key, job_id);
        governor::within(Some(g.lane()), f).await
    }

    /// The worker's jobs running now: report jobs and the two collections' open runs. One
    /// definition, for the view, the timers' room and the report queue's slots.
    pub(crate) fn jobs_running_now(&self) -> u32 {
        self.reports.queue.lock().running() as u32 + self.collections_open()
    }

    fn collections_open(&self) -> u32 {
        [jobs::VOLUME_DAILY, jobs::HOSTS_COLLECT].iter().filter(|j| self.jobs.running(j).is_some()).count() as u32
    }

    /// Whether a timer may begin a new run of `job` (one already open takes more clusters in).
    /// A person's run is never held by this.
    pub(crate) fn governor_room(&self, job: &str) -> bool {
        self.jobs.running(job).is_some() || self.jobs_running_now() < self.jobs.controls().overall.most_at_once
    }

    /// Report jobs that may run at once: `mostAtOnce` less the collections open, at least one —
    /// a person's report always has a slot. (`REPORT_CONCURRENCY_SET` writes `mostAtOnce`.)
    pub(crate) fn report_slots(&self) -> usize {
        self.jobs.controls().overall.most_at_once.saturating_sub(self.collections_open()).max(1) as usize
    }

    /* ------------------------------------------ the tick ------------------------------------------ */

    /// Role worker / all: decide every `TICK_SECS`. Role core: publish people waiting every
    /// `CORE_LOAD_EVERY_SECS`. The core's gate limits from the settings, once, at start.
    pub fn start_governor(self: &Arc<Self>) {
        self.apply_gate_settings();
        let weak = Arc::downgrade(self);
        let core_side = self.role == Role::Core;
        if core_side && self.data_dir.is_none() {
            return;
        }
        tokio::spawn(async move {
            let every = if core_side { governor::CORE_LOAD_EVERY_SECS } else { governor::TICK_SECS };
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(every)).await;
                let Some(core) = weak.upgrade() else { break };
                let now = crate::fleet::now_ms();
                if core_side {
                    let c = core.clone();
                    let _ = tokio::task::spawn_blocking(move || c.core_load_publish(now)).await;
                } else {
                    core.governor_tick_at(now);
                }
            }
        });
    }

    /// The core's gate as people meet it now.
    pub(crate) fn core_load(&self, now: u64) -> CoreLoad {
        let load = self.gate.load();
        CoreLoad {
            at: now,
            waiting: (load.queued[0] + load.queued[1]) as u64,
            waited: self.gate.people_waited(governor::PEOPLE_WINDOW_MS, governor::PEOPLE_WAIT_MS) as u64,
        }
    }

    /// Role core: `<data>/job-runs/core-load.json` for the worker. Public for the tests.
    #[doc(hidden)]
    pub fn core_load_publish(&self, now: u64) {
        if self.role != Role::Core {
            return;
        }
        let Some(d) = self.data_dir.as_deref() else { return };
        let body = serde_json::to_vec(&self.core_load(now)).unwrap_or_default();
        if let Err(e) = crate::volume::store::write_atomic(&d.join(jobs::DIR).join(governor::CORE_LOAD_FILE), &body) {
            tracing::warn!(error = %e, "governor: the core's load could not be published for the worker");
        }
    }

    /// People waiting at the core's gate: this process's own gate in role all, the core's
    /// publication in role worker (not known when it is missing or stale).
    fn people_waiting(&self, now: u64) -> Option<u64> {
        match self.role {
            Role::All => self.core_load(now).people(now),
            _ => {
                let d = self.data_dir.as_deref()?;
                let p = crate::worker::read_json_retry::<CoreLoad>(&d.join(jobs::DIR).join(governor::CORE_LOAD_FILE)).ok().flatten()?;
                p.people(now)
            }
        }
    }

    /// The signals of one tick, measured now; the lanes' figures since the last tick are taken.
    fn governor_signals(&self, now: u64) -> Signals {
        let sampler = self.health.monitor.lock().sampler.clone();
        let raw = sampler.read(now);
        let mut st = self.governor.state.lock();
        let (mut cpu_pct, mut throttled_pct) = (None, None);
        if let Some(c) = &raw.cpu {
            if let Some((t0, u0, p0, th0)) = st.prev_cpu {
                let cpus = raw.cpu_limit.unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get() as f64).unwrap_or(1.0));
                cpu_pct = crate::health::cpu_pct(t0, u0, now, c.usage_usec).map(|p| p / cpus.max(0.01));
                if let (Some(p0), Some(th0), Some(p1), Some(th1)) = (p0, th0, c.nr_periods, c.nr_throttled) {
                    if p1 > p0 {
                        throttled_pct = Some(th1.saturating_sub(th0) as f64 * 100.0 / (p1 - p0) as f64);
                    }
                }
            }
            st.prev_cpu = Some((now, c.usage_usec, c.nr_periods, c.nr_throttled));
        }
        drop(st);
        let memory_pct = match (raw.rss, raw.limit) {
            (Some(u), Some(l)) if l > 0 => Some(u as f64 * 100.0 / l as f64),
            _ => None,
        };
        let (mut ms, mut n, mut in_work) = (0u64, 0u64, std::collections::HashSet::new());
        for l in self.governor.lanes().iter().filter(|l| !l.fixed) {
            let (m, k, c) = l.take();
            ms += m;
            n += k;
            in_work.extend(c);
        }
        let rejecting = !in_work.is_empty() && governor::rejecting(&in_work, &self.busy_now());
        Signals {
            cpu_pct: cpu_pct.map(|p| (p * 10.0).round() / 10.0),
            memory_pct: memory_pct.map(|p| (p * 10.0).round() / 10.0),
            people_waiting: self.people_waiting(now),
            queue: Some(self.reports.queue.lock().queued() as u64),
            avg_page_ms: (n > 0).then(|| ms / n),
            throttled_pct,
            rejecting,
        }
    }

    /// One tick: measure, decide, share, apply. Public for the tests (the loop calls it every
    /// ten seconds).
    #[doc(hidden)]
    pub fn governor_tick_at(self: &Arc<Self>, now: u64) -> Value {
        if !self.role.runs_batch() {
            return Value::Null;
        }
        let c = self.jobs.controls();
        let signals = self.governor_signals(now);
        let floor = self.governor.floor(&c);
        {
            let mut st = self.governor.state.lock();
            let cur = if st.total == 0 { governor::start(&c.overall, floor) } else { st.total };
            let (to, why) = governor::step(cur, &signals, &c.overall, floor);
            if let Some(reason) = why {
                st.last_change = Some(Change { at: now, from: cur, to, reason });
                if reason != governor::Reason::Calm {
                    tracing::info!(from = cur, to, reason = ?reason, "governor: the jobs' requests changed");
                }
            }
            st.total = to;
            st.signals = signals;
        }
        let view = self.governor_share(&c);
        // The queue takes up what mostAtOnce now allows.
        self.report_pump();
        serde_json::to_value(view).unwrap_or(Value::Null)
    }

    /// Share the current total among the lanes, size the worker's gate, and keep the view.
    fn governor_share(&self, c: &Controls) -> View {
        let floor = self.governor.floor(c);
        let total = {
            let mut st = self.governor.state.lock();
            if st.total == 0 {
                st.total = governor::start(&c.overall, floor);
            }
            st.total
        };
        let given = self.governor.apply(total, c);
        let moved: u32 = given.iter().filter(|(l, _)| !l.fixed).map(|(_, a)| a.requests).sum();
        if self.role == Role::Worker {
            // The worker's own gate: the total, or what the minimums need, never above the
            // administrator's workerTotal (nor ELASTICPRO_WORKER_GATE_CONCURRENCY when it is set).
            let env_cap = std::env::var("ELASTICPRO_WORKER_GATE_CONCURRENCY").ok().and_then(|v| v.trim().parse::<u32>().ok()).filter(|n| *n > 0);
            let global = total.max(moved).min(c.overall.worker_total.max(1)).min(env_cap.unwrap_or(u32::MAX)).max(1) as usize;
            let mut l = self.gate.limits();
            if l.global != global {
                l.global = global;
                self.gate.set_limits(l);
            }
        }
        let jobs_running = self.jobs_running_now();
        let mut st = self.governor.state.lock();
        let view = View {
            auto: c.overall.auto,
            in_use: given.iter().filter(|(l, _)| !l.fixed).map(|(l, _)| l.in_flight()).sum(),
            total,
            most_at_once: c.overall.most_at_once,
            jobs_running,
            last_change: st.last_change.clone(),
            signals: st.signals.clone(),
            allocations: governor::by_job(&given.into_iter().filter(|(l, _)| !l.fixed).collect::<Vec<_>>()),
        };
        st.view = Some(view.clone());
        view
    }

    /// `JOBS_LIST.governor`, and each job's allocation (by job id). The worker's jobs as this
    /// process's own tick left them (role all), or as the worker's heartbeat said (role core;
    /// nothing when the heartbeat is missing or late — never an old figure as if it were now);
    /// the core's own jobs while they run, at their fixed maximum.
    pub(crate) fn governor_for_list(&self) -> (Value, std::collections::BTreeMap<String, governor::Allocation>) {
        let now = crate::fleet::now_ms();
        let view: Option<View> = match self.role {
            Role::Core => self.data_dir.as_deref()
                .and_then(|d| crate::health::WorkerStatus::read(d).ok().flatten())
                .filter(|st| !crate::health::heartbeat_late(st.heartbeat_at, now))
                .and_then(|st| st.governor),
            _ => {
                let held = self.governor.state.lock().view.clone();
                Some(held.unwrap_or_else(|| self.governor_share(&self.jobs.controls())))
            }
        };
        let mut allocations = view.as_ref().map(|v| v.allocations.clone()).unwrap_or_default();
        // The core's own jobs, while a run of theirs is open.
        let c = self.jobs.controls();
        for l in self.governor.lanes().iter().filter(|l| l.fixed && self.jobs.running(&l.job_id).is_some()) {
            let (min, max, _, _) = governor::settings_of(&c, &l.job_id);
            allocations.entry(l.job_id.clone()).or_insert(governor::Allocation { requests: max, min, max, auto: false, reason: "fixed".into() });
        }
        (view.map(|v| v.top()).unwrap_or(Value::Null), allocations)
    }

    /* ------------------------------------------ the core's gate ------------------------------------------ */

    /// The core's gate limits: config.txt's (or the defaults) with `JOB_SETTINGS_SET overall`'s
    /// over them where config.txt says nothing. Applied at start and after every save; what is
    /// running keeps running. Role worker has its own gate (`worker::worker_limits`).
    pub(crate) fn apply_gate_settings(&self) {
        if !self.role.serves_people() {
            return;
        }
        let l = self.jobs.controls().overall.gate_limits(&crate::gate::config().limits, gate_locked);
        if self.gate.limits() != l {
            tracing::info!(global = l.global, per_cluster = l.per_cluster, per_jump = l.per_jump, reserve = l.background_reserve,
                           "the core's gate limits changed (JOB_SETTINGS_SET)");
            self.gate.set_limits(l.clone());
            self.req_cfg.write().limits = l;
        }
    }

    /// The core's gate fields for `JOB_SETTINGS_GET`: each in force, whether config.txt sets it.
    pub(crate) fn gate_settings_view(&self) -> Value {
        let l = self.gate.limits();
        let mut out = serde_json::Map::new();
        for (name, key, lo, hi) in crate::jobs::controls::GATE_FIELDS {
            let v = match name {
                "esConcurrency" => l.global,
                "esPerCluster" => l.per_cluster,
                "esPerJumpHost" => l.per_jump,
                _ => l.background_reserve,
            };
            out.insert(name.into(), json!({ "value": v, "lockedBy": gate_locked(key).then_some(format!("config.txt {key}")), "min": lo, "max": hi }));
        }
        Value::Object(out)
    }
}
