//! The core's side of docs/WORKER.md: forwarding actions to the report worker, the worker's
//! internal HTTP API, its heartbeat (`worker/status.json`), its requests ring
//! (`worker/requests.jsonl`) and the settings it reloads when the core changes them.
//!
//! Pure parts (the role table, the token, the replies) are `crate::worker`; this file only
//! wires them to the core. Nothing here sends a cluster anything.

use super::{Caller, Core};
use crate::health::{self, UpstreamRec, WorkerStatus};
use crate::worker::{self, Forward, Role, Watch, WireCaller};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The core/worker split as one process sees it.
pub(crate) struct WorkerSide {
    data: Option<PathBuf>,
    /// The shared secret, once read (or made).
    token: parking_lot::Mutex<Option<String>>,
    url: parking_lot::Mutex<String>,
    /// The worker's finished requests, for `worker/requests.jsonl`.
    ring: parking_lot::Mutex<worker::RequestRing>,
    /// Settings files the core writes and the worker reads again when they change.
    pub(crate) primed: Watch,
    pub(crate) pins: Watch,
    pub(crate) secrets: Watch,
    pub(crate) link: Watch,
    pub(crate) policy: Watch,
    started: AtomicBool,
    pub(crate) started_at: u64,
}

impl WorkerSide {
    pub(crate) fn new(data: Option<&Path>, role: Role) -> WorkerSide {
        let watch = |name: &str| data.map(|d| Watch::primed(&d.join(name))).unwrap_or_default();
        let ring = match (role, data) {
            (Role::Worker, Some(d)) => worker::RequestRing::load(d),
            _ => worker::RequestRing::default(),
        };
        let side = WorkerSide {
            data: data.map(Path::to_path_buf),
            token: parking_lot::Mutex::new(None),
            url: parking_lot::Mutex::new(worker::url()),
            ring: parking_lot::Mutex::new(ring),
            primed: watch(super::PRIMED_FILE),
            pins: watch("pins.json"),
            secrets: watch(crate::cluster_secrets::FILE),
            link: watch(crate::zbx_link::LINK_FILE),
            policy: watch(crate::fleet::policy::FILE_NAME),
            started: AtomicBool::new(false),
            started_at: crate::fleet::now_ms(),
        };
        // Whoever starts first makes the token; the other reads it.
        if role != Role::All {
            let _ = side.token();
        }
        side
    }

    /// The shared secret, made when missing. `None` without a data directory, or when the
    /// file cannot be made (said in the log).
    pub(crate) fn token(&self) -> Option<String> {
        let mut t = self.token.lock();
        if t.is_none() {
            let d = self.data.as_deref()?;
            match worker::token(d) {
                Ok(v) => *t = Some(v),
                Err(e) => tracing::warn!(error = %e, "report worker: the shared token could not be read or made"),
            }
        }
        t.clone()
    }
}

/// Jobs as the worker's heartbeat lists them: what runs, with its progress.
fn running_lines(q: &crate::report::jobs::Queue) -> (Vec<health::JobLine>, u64) {
    let running = q.jobs.iter().filter(|j| j.status == crate::report::jobs::Status::Running)
        .map(|j| health::job_line(&crate::report::job_view(j))).collect();
    (running, q.queued() as u64)
}

impl Core {
    /// What this process is (docs/WORKER.md).
    pub fn role(&self) -> Role {
        self.role
    }

    /* ---------------------------------------- forwarding ---------------------------------------- */

    /// Role core: hand an action to the worker, as `caller` (the core has checked the role,
    /// the clusters and the limits). Worker down or unreachable: `worker_unavailable`, with the
    /// last heartbeat — nothing else is affected.
    pub(crate) async fn forward_to_worker(&self, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(path) = worker::endpoint(t) else {
            return json!({ "ok": false, "kind": "bad_message", "message": format!("{t} is not forwarded to the report worker") });
        };
        let heartbeat = || self.data_dir.as_deref().and_then(|d| WorkerStatus::read(d).ok().flatten()).map(|s| s.heartbeat_at);
        let Some(token) = self.worker.token() else {
            return worker::unavailable("no shared token: the core and the worker need the same data volume", heartbeat());
        };
        let mut m = msg.clone();
        if let Some(o) = m.as_object_mut() {
            // Nothing that identifies a person's session travels to the worker.
            o.remove("session");
        }
        let body = serde_json::to_value(Forward { kind: t.to_string(), msg: m, caller: caller.map(WireCaller::of) }).unwrap_or(Value::Null);
        let url = self.worker.url.lock().clone();
        match worker::send(&url, &token, path, &body).await {
            Ok(mut v) => {
                crate::errors::stamp(&mut v);
                v
            }
            Err(e) => {
                tracing::warn!(error = %e, msg_type = t, "report worker unreachable");
                worker::unavailable(&e, heartbeat())
            }
        }
    }

    /// The worker as Exports shows it beside a schedule: `{state, heartbeatAt, text}`. `None`
    /// in role all (there is no worker).
    pub(crate) fn worker_line(&self) -> Option<Value> {
        if self.role == Role::All {
            return None;
        }
        let file = match self.data_dir.as_deref() {
            Some(d) => WorkerStatus::read(d),
            None => Ok(None),
        };
        let v = health::worker_view(self.role.as_str(), file, crate::fleet::now_ms(), crate::VERSION);
        Some(json!({ "state": v.state, "heartbeatAt": v.status.as_ref().map(|s| s.heartbeat_at), "text": v.text, "level": v.level }))
    }

    /// Where this core finds the worker, instead of `ELASTICPRO_WORKER_URL`. Tests only.
    #[doc(hidden)]
    pub fn set_worker_url_for_tests(&self, url: &str) {
        *self.worker.url.lock() = url.trim_end_matches('/').to_string();
    }

    /* ---------------------------------------- the worker's API ---------------------------------------- */

    /// One request to the worker's internal port: `POST /run`, `/send-now`, `/stop`, `/queue`.
    /// The token and the version first; then the forwarded message is handled here exactly as
    /// role all would handle it, as the person the core vouched for.
    pub async fn worker_http(self: &Arc<Self>, path: &str, token: Option<&str>, version: Option<&str>, body: &[u8]) -> (u16, Value) {
        let expected = self.worker.token().unwrap_or_default();
        if let Err((code, v)) = worker::check(&expected, token, version, crate::VERSION) {
            if code == 409 {
                tracing::warn!(core = version.unwrap_or(""), worker = crate::VERSION, "report worker: refused a core of another version");
            }
            return (code, v);
        }
        let fwd: Forward = match serde_json::from_slice(body) {
            Ok(f) => f,
            Err(e) => return (400, json!({ "ok": false, "kind": "bad_request", "message": format!("not a forwarded action: {e}") })),
        };
        if !worker::accepts(path, &fwd.kind) {
            return (400, json!({ "ok": false, "kind": "bad_request", "message": format!("{} is not taken at {path}", fwd.kind) }));
        }
        let caller = match &fwd.caller {
            None => None,
            Some(c) => match c.caller() {
                Some(c) => Some(c),
                None => return (400, json!({ "ok": false, "kind": "bad_request", "message": format!("unknown role {:?}", c.role) })),
            },
        };
        let mut out = if fwd.kind == "VOLUME_RUN" {
            self.volume_msg(&fwd.kind, &fwd.msg, caller.as_ref()).await
        } else {
            self.report_msg(&fwd.kind, &fwd.msg, caller.as_ref()).await
        };
        crate::errors::stamp(&mut out);
        (200, out)
    }

    /// `GET /health` of the worker: up, its version, its queue. Never asks a cluster.
    pub fn worker_health(&self) -> Value {
        let q = self.reports.snapshot();
        json!({ "ok": true, "role": self.role.as_str(), "version": crate::VERSION, "startedAt": self.worker.started_at,
                "running": q.running(), "queued": q.queued() })
    }

    /* ---------------------------------------- the worker's loops ---------------------------------------- */

    /// Role worker: the heartbeat every 10 s (status file and requests ring), and every 30 s
    /// the settings the core may have changed. Started by the bridge binary.
    pub fn start_worker_loops(self: &Arc<Self>) {
        if self.role != Role::Worker || self.data_dir.is_none() || self.worker.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut n: u64 = 0;
            loop {
                let Some(core) = weak.upgrade() else { break };
                let sample = n.is_multiple_of(health::SAMPLE_EVERY_SECS / worker::HEARTBEAT_SECS);
                let c = core.clone();
                let _ = tokio::task::spawn_blocking(move || c.worker_heartbeat(crate::fleet::now_ms(), sample)).await;
                if n.is_multiple_of(worker::RELOAD_SECS / worker::HEARTBEAT_SECS) && n > 0 {
                    core.worker_reload().await;
                }
                drop(core);
                n += 1;
                tokio::time::sleep(std::time::Duration::from_secs(worker::HEARTBEAT_SECS)).await;
            }
        });
        tracing::info!(target: "audit", "report worker: heartbeat started");
    }

    /// One heartbeat: `worker/status.json` and `worker/requests.jsonl`. `sample`: also read
    /// memory and CPU (once a minute) into the day's ring, `health/worker.json`.
    pub fn worker_heartbeat(&self, now: u64, sample: bool) {
        let Some(d) = self.data_dir.as_deref() else { return };
        let (memory, cpu, hour) = {
            let mut m = self.health.monitor.lock();
            if sample || m.raw.is_none() {
                m.read(now);
                let s = m.sample();
                m.push(s);
                let n = self.health.samples.fetch_add(1, Ordering::SeqCst) + 1;
                if n.is_multiple_of(health::PERSIST_EVERY_SAMPLES) {
                    if let Err(e) = m.ring.save(d, "worker") {
                        tracing::warn!(error = %e, "report worker: the day's samples could not be written");
                    }
                }
            }
            let (mem, cpu) = m.figures();
            (mem, cpu, m.ring.refusals_within(now, 3_600_000))
        };
        // The worker's finished requests: for the gate figures and the ring.
        type Rec = (u64, String, u64, Option<u64>, Option<String>, bool, Value);
        let recs: Vec<Rec> = {
            let log = self.requests.lock();
            log.recent.iter()
                .map(|r| (r.id, r.cluster.clone(), r.started_at, r.ms, r.status.clone(),
                          r.sent && !r.shared && !r.cached && !r.status.as_deref().is_some_and(|s| ["overloaded", "queue_timeout", "aborted", "client_gone"].contains(&s)),
                          serde_json::to_value(r).unwrap_or(Value::Null)))
                .collect()
        };
        let ups: Vec<UpstreamRec<'_>> = recs.iter().filter(|r| now.saturating_sub(r.2) <= 5 * health::MINUTE_MS + 120_000)
            .map(|r| UpstreamRec { cluster: &r.1, at_ms: r.2, ms: r.3, status: r.4.as_deref(), sent: r.5 }).collect();
        let gate = health::gate_figures("worker", &self.gate, &ups, hour, None);
        let (jobs, queued) = running_lines(&self.reports.queue.lock());
        let mut collection: Vec<health::CollectionLine> = self.volume.runs.lock().iter().filter(|(_, r)| r.running)
            .map(|(id, r)| health::CollectionLine { cluster_id: id.clone(), kind: "volume".into(),
                                                    progress: health::Count { done: r.done, total: r.total }, concurrency: None })
            .collect();
        collection.extend(self.reports.hosts_running.lock().iter()
            .map(|id| health::CollectionLine { cluster_id: id.clone(), kind: "hosts".into(), progress: Default::default(), concurrency: None }));
        collection.sort_by(|a, b| (a.kind.as_str(), a.cluster_id.as_str()).cmp(&(b.kind.as_str(), b.cluster_id.as_str())));
        let st = WorkerStatus {
            schema: health::WORKER_STATUS_SCHEMA, role: "worker".into(), version: crate::VERSION.into(), pid: Some(std::process::id()),
            started_at: self.worker.started_at, heartbeat_at: now, memory, cpu, gate: Some(gate), jobs, queued, collection,
        };
        if let Err(e) = st.write(d) {
            tracing::warn!(error = %e, "report worker: the status file could not be written");
        }
        let mut ring = self.worker.ring.lock();
        ring.add(recs.into_iter().map(|r| (r.0, r.6)));
        if let Err(e) = ring.flush(d) {
            tracing::warn!(error = %e, "report worker: the requests ring could not be written");
        }
    }

    /// Settings the core changed since the last look: the cluster setup (primed.json), trust
    /// decisions (pins.json), kept credentials (cluster-secrets.json) and the Zabbix link. The
    /// schedules, mail and config files are read afresh wherever they are used.
    pub async fn worker_reload(self: &Arc<Self>) {
        let Some(d) = self.data_dir.clone() else { return };
        if self.worker.pins.changed(&d.join("pins.json")) {
            self.pins.reload();
            self.forget_connections();
            tracing::info!("report worker: trust decisions reloaded");
        }
        let secrets = self.worker.secrets.changed(&d.join(crate::cluster_secrets::FILE));
        if secrets {
            self.cluster_secrets.reload();
        }
        let link = self.worker.link.changed(&d.join(crate::zbx_link::LINK_FILE));
        if link {
            self.zbx_link.reload();
            self.apply_link();
        }
        if self.worker.primed.changed(&d.join(super::PRIMED_FILE)) || secrets {
            self.restore_prime().await;
        }
        if (link || secrets) && self.zbx_api().configured() {
            self.zabbix_sync().await;
        }
        self.fleet_policy_reload();
    }

    /// Role worker: the emergency stop and the request policy as the core last wrote them
    /// (`policy.json`), read again when the file changed. Called before every collection
    /// request and page (`volume_stopped`).
    pub(crate) fn fleet_policy_reload(&self) {
        if self.role != Role::Worker {
            return;
        }
        let Some(p) = self.fleet.policy_path.clone() else { return };
        if self.worker.policy.changed(&p) {
            self.fleet.reload_policy();
        }
    }

    /// Role core: the worker's finished requests for the Request Centre, labelled
    /// `process: "worker"`, the newest `limit` first, held to the clusters `sees` allows.
    pub(crate) fn worker_requests(&self, limit: usize, sees: impl Fn(&str) -> bool) -> Vec<Value> {
        if self.role != Role::Core {
            return vec![];
        }
        let Some(d) = self.data_dir.as_deref() else { return vec![] };
        worker::read_requests(d, crate::worker::REQUESTS_KEEP).into_iter()
            .filter(|r| sees(r.get("cluster").and_then(Value::as_str).unwrap_or("")))
            .take(limit).collect()
    }
}
