//! The fleet cache: the core polls every cluster itself, on a schedule, and pages read
//! what it last found instead of each browser tab asking every cluster again.
//!
//! With a hundred and twenty clusters the old way was some fifteen hundred requests per
//! tab per refresh. Now it is one poller per core, with limits per cluster, per jump host
//! and overall, and one `FLEET_STATE` per tab.
//!
//! Nothing here goes around the core: every fetch is an `es_req`, so it takes the same
//! jump hosts, pinned certificates, credentials and read-only guard as a page's request,
//! and it is counted in the same request statistics. And nothing here writes — every
//! dataset is a GET.
//!
//! The poller is started explicitly, like the delay sink: a scheduler that started itself
//! in `Core::new` would run in every test.

pub mod catalogue;
pub mod entry;
pub mod events;
pub mod scheduler;
pub mod store;

use crate::auth::{Caller, Role};
use crate::bridge::Core;
use crate::http::EsRequest;
use catalogue::{Class, Dataset, Query, ALL};
use entry::{answer, error_of, reached, Entry, Outcome, ReachState, Status};
use events::{EventsOwner, FleetEvent, Reauth, Tickets};
use parking_lot::Mutex;
use scheduler::{Candidate, Config, SpecLite, State};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// The longest a `CLUSTER_DATASET` with `wait` holds the request open.
pub const MAX_WAIT: Duration = Duration::from_secs(20);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct Fleet {
    pub(crate) state: Mutex<State>,
    pub(crate) cfg: Config,
    wake: tokio::sync::Notify,
    events: broadcast::Sender<FleetEvent>,
    tickets: Tickets,
    disk: Arc<store::DiskStore>,
    #[cfg(feature = "bridge")]
    redis: Arc<store::RedisStore>,
    started: AtomicBool,
    /// Which run of the core this is. `seq` starts again from zero on a restart, so a
    /// client holding `since` from before would otherwise take "nothing newer" for an
    /// answer; a changed epoch tells it to ask for everything.
    epoch: String,
}

impl Fleet {
    pub fn new(data_dir: Option<&std::path::Path>) -> Fleet {
        let (events, _) = broadcast::channel(1024);
        Fleet {
            state: Mutex::new(State::default()),
            cfg: Config::from_env(),
            wake: tokio::sync::Notify::new(),
            events,
            tickets: Tickets::default(),
            disk: Arc::new(store::DiskStore::new(data_dir)),
            #[cfg(feature = "bridge")]
            redis: Arc::new(store::RedisStore::from_env()),
            started: AtomicBool::new(false),
            epoch: crate::auth::random_hex(8),
        }
    }
}

fn is_guest(caller: Option<&Caller>) -> bool {
    caller.is_some_and(|c| c.role == Role::Guest)
}

fn dataset_list(v: Option<&Value>) -> Option<Vec<Dataset>> {
    let a = v?.as_array()?;
    Some(a.iter().filter_map(|x| x.as_str().and_then(Dataset::parse)).collect())
}

fn background() -> Vec<Dataset> {
    ALL.into_iter().filter(|d| d.class() == Class::Background).collect()
}

impl Core {
    /* ---------------------------------- starting ---------------------------------- */

    /// Start polling. Called once, inside the runtime, by the bridge binary and by the
    /// desktop shell's setup — never by `Core::new`.
    pub fn start_fleet_poller(self: &Arc<Self>) {
        if self.fleet.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let restored = self.fleet.disk.load_all();
        let n = restored.len();
        {
            let mut st = self.fleet.state.lock();
            // The first ten minutes count as watched, so a restart warms the whole cache
            // before the first person arrives instead of when they do.
            st.last_activity = now_ms();
            for (c, ds, mut e) in restored {
                e.seq = st.next_seq();
                st.entries.insert((c, ds), e);
            }
        }
        // Held weakly, so the poller ends with the core instead of keeping it alive.
        let weak = Arc::downgrade(self);
        // Redis is read on the side: a Redis that is down costs a connect timeout, and the
        // poller does not wait for it. Only entries newer than what memory holds are taken.
        #[cfg(feature = "bridge")]
        {
            let core = self.clone();
            tokio::spawn(async move { core.fleet_restore_redis().await });
        }
        tokio::spawn(async move {
            while let Some(core) = weak.upgrade() {
                core.fleet_tick().await;
                tokio::select! {
                    _ = core.fleet.wake.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
            }
        });
        tracing::info!(
            restored = n, health_secs = self.fleet.cfg.health_secs, concurrency = self.fleet.cfg.global,
            "fleet poller started"
        );
    }

    /// Whether the fleet cache is running — what PING reports as `fleetCache`, and what
    /// tells the UI to read from it instead of asking clusters directly.
    pub fn fleet_enabled(&self) -> bool {
        self.fleet.started.load(Ordering::SeqCst)
    }

    /// This run's epoch; see `Fleet::epoch`.
    pub fn fleet_epoch(&self) -> &str {
        &self.fleet.epoch
    }

    /// The newest `seq` handed out so far.
    pub fn fleet_seq(&self) -> u64 {
        self.fleet.state.lock().seq
    }

    /// Something is looking. See `scheduler::IDLE_MS`.
    pub fn fleet_touch(&self) {
        self.fleet.state.lock().last_activity = now_ms();
    }

    #[cfg(feature = "bridge")]
    async fn fleet_restore_redis(&self) {
        if !self.fleet.redis.configured() {
            return;
        }
        let got = self.fleet.redis.load_all().await;
        let mut st = self.fleet.state.lock();
        let mut n = 0;
        for (c, ds, mut e) in got {
            let key = (c, ds);
            let newer = st.entries.get(&key).is_none_or(|have| have.fetched_at < e.fetched_at);
            if newer {
                e.seq = st.next_seq();
                st.entries.insert(key, e);
                n += 1;
            }
        }
        if n > 0 {
            tracing::info!(restored = n, "fleet cache: newer entries restored from redis");
        }
    }

    /* ---------------------------------- polling ---------------------------------- */

    async fn fleet_tick(self: &Arc<Self>) {
        let all = self.all_specs();
        let specs: Vec<SpecLite> = all.iter().map(|s| SpecLite { id: s.id.clone(), via: s.via.clone().filter(|v| !v.is_empty()) }).collect();
        let patterns: HashMap<String, Option<String>> = all.iter().map(|s| (s.id.clone(), s.log_index_pattern.clone())).collect();
        let keep: HashSet<String> = specs.iter().map(|s| s.id.clone()).collect();
        let backing_off: HashSet<String> = {
            let ts = self.tunnels.read().await;
            ts.iter().filter(|(_, r)| r.tunnel.backing_off()).map(|(k, _)| k.clone()).collect()
        };
        let now = now_ms();
        let (start, gone) = {
            let mut st = self.fleet.state.lock();
            if !keep.is_empty() {
                st.seen_clusters = true;
            }
            let gone = if st.seen_clusters { st.prune(&keep) } else { vec![] };
            let plan = st.plan(&specs, now, &backing_off);
            (st.take(plan, &specs, &self.fleet.cfg), gone)
        };
        if !gone.is_empty() {
            tracing::info!(clusters = ?gone, "fleet cache: dropping clusters that are no longer configured");
            let disk = self.fleet.disk.clone();
            let keep2 = keep.clone();
            tokio::task::spawn_blocking(move || disk.prune(&keep2));
            #[cfg(feature = "bridge")]
            {
                let redis = self.fleet.redis.clone();
                tokio::spawn(async move {
                    for c in gone {
                        redis.remove_cluster(&c).await;
                    }
                });
            }
        }
        for c in start {
            let lp = patterns.get(&c.cluster).cloned().flatten();
            tokio::spawn(self.clone().fleet_job(c, lp));
        }
    }

    async fn fleet_get(self: &Arc<Self>, cluster: &str, q: &Query) -> Value {
        let req = EsRequest {
            cluster_id: cluster.to_string(),
            url: None,
            method: "GET".into(),
            path: q.path.clone(),
            body: None,
            timeout_ms: Some(q.timeout_ms),
            auth_header: None,
            allow_writes: false,
        };
        answer(self.es_req(req).await)
    }

    /// Repository names from the cached `policies` answer, when there is a good one.
    fn fleet_known_repos(&self, cluster: &str) -> Option<Vec<String>> {
        let st = self.fleet.state.lock();
        let e = st.entries.get(&(cluster.to_string(), Dataset::Policies))?;
        let repos = e.data.as_ref()?.get("repos")?;
        if repos.get("ok") != Some(&json!(true)) {
            return None;
        }
        let mut names: Vec<String> = repos.get("json")?.as_object()?.keys().cloned().collect();
        names.sort();
        Some(names)
    }

    /// One dataset, request by request. Sequential on purpose: two jobs per cluster at
    /// most, each asking one thing at a time, is the load this was built to keep to.
    async fn fleet_fetch(self: &Arc<Self>, cluster: &str, ds: Dataset, log_pattern: Option<&str>) -> Outcome {
        let mut map = Map::new();
        match ds {
            Dataset::Snapshots | Dataset::SnapshotsFull => {
                let repos = match self.fleet_known_repos(cluster) {
                    Some(r) => r,
                    None => {
                        let q = Query { key: "repos".into(), path: catalogue::REPOS_PATH.into(), timeout_ms: 15_000 };
                        let a = self.fleet_get(cluster, &q).await;
                        if !reached(&a) {
                            return Outcome::Failed(error_of("repos", &a));
                        }
                        let mut names: Vec<String> = a.get("json").and_then(Value::as_object)
                            .map(|m| m.keys().cloned().collect()).unwrap_or_default();
                        names.sort();
                        if a.get("ok") != Some(&json!(true)) {
                            // Which repositories exist could not be read. Said so, rather
                            // than answering "no snapshots".
                            map.insert("repos".into(), a);
                        }
                        names
                    }
                };
                let mut by = Map::new();
                for r in repos {
                    let Some(q) = ds.repo_query(&r) else { continue };
                    let mut a = self.fleet_get(cluster, &q).await;
                    let mut source = if ds == Dataset::Snapshots { "cat" } else { "verbose" };
                    // The verbose listing fails on some repositories (a missing blob, an
                    // old ES); _cat still counts them, without the index names — which
                    // the page then says it cannot know, rather than showing none.
                    if ds == Dataset::SnapshotsFull && a.get("ok") != Some(&json!(true)) {
                        let cat = Query { key: r.clone(), path: catalogue::snapshots_cat_path(&r), timeout_ms: 30_000 };
                        let b = self.fleet_get(cluster, &cat).await;
                        if reached(&b) {
                            a = b;
                            source = "cat";
                        }
                    }
                    if !reached(&a) {
                        return Outcome::Failed(error_of(&r, &a));
                    }
                    a["source"] = json!(source);
                    by.insert(r, a);
                }
                map.insert("byRepo".into(), Value::Object(by));
            }
            Dataset::Health => {
                // Reachable when either answers — the same rule the page used.
                let mut first_err = None;
                for q in ds.queries(log_pattern) {
                    let a = self.fleet_get(cluster, &q).await;
                    if !reached(&a) && first_err.is_none() {
                        first_err = Some(error_of(&q.key, &a));
                    }
                    map.insert(q.key, a);
                }
                if !map.values().any(reached) {
                    return Outcome::Failed(first_err.unwrap_or(json!({ "kind": "unknown", "message": "" })));
                }
            }
            _ => {
                for q in ds.queries(log_pattern) {
                    let a = self.fleet_get(cluster, &q).await;
                    if !reached(&a) {
                        return Outcome::Failed(error_of(&q.key, &a));
                    }
                    map.insert(q.key, a);
                }
            }
        }
        Outcome::Answered(map)
    }

    async fn fleet_job(self: Arc<Self>, c: Candidate, log_pattern: Option<String>) {
        let t0 = std::time::Instant::now();
        let outcome = self.fleet_fetch(&c.cluster, c.dataset, log_pattern.as_deref()).await;
        let took = t0.elapsed().as_millis() as u64;
        self.fleet_finish((c.cluster, c.dataset), outcome, took);
    }

    fn fleet_finish(self: &Arc<Self>, key: scheduler::Key, outcome: Outcome, took: u64) {
        let now = now_ms();
        let cfg = &self.fleet.cfg;
        let (waiters, reach_changed, entry, reach) = {
            let mut st = self.fleet.state.lock();
            let (w, rc) = st.complete(&key, outcome, took, now, cfg, &mut catalogue::jittered_ms);
            if key.1.class() == Class::OnDemand {
                st.evict(cfg.cache_bytes);
            }
            (w, rc, st.entries.get(&key).cloned(), st.reach.get(&key.0).cloned())
        };
        for w in waiters {
            let _ = w.send(());
        }
        if let Some(e) = entry {
            let _ = self.fleet.events.send(FleetEvent {
                cluster_id: key.0.clone(),
                dataset: Some(key.1),
                payload: json!({ "clusterId": key.0, "dataset": key.1.name(), "seq": e.seq,
                                 "status": e.status, "fetchedAt": e.fetched_at }),
            });
            if e.status == Status::Ok {
                let disk = self.fleet.disk.clone();
                let (c, ds) = key.clone();
                #[cfg(feature = "bridge")]
                let (redis, ttl) = (self.fleet.redis.clone(), 3 * ds.interval_secs(cfg.health_secs));
                #[cfg(feature = "bridge")]
                let update = json!({ "clusterId": c, "dataset": ds.name(), "seq": e.seq }).to_string();
                tokio::task::spawn_blocking(move || {
                    disk.save(&c, ds, &e, now);
                    #[cfg(feature = "bridge")]
                    if redis.configured() {
                        if let Ok(body) = serde_json::to_string(&e) {
                            tokio::runtime::Handle::current().spawn(async move { redis.put(&c, ds, &body, ttl, &update).await });
                        }
                    }
                });
            }
        }
        if let (true, Some(r)) = (reach_changed, reach) {
            let _ = self.fleet.events.send(FleetEvent {
                cluster_id: key.0.clone(),
                dataset: None,
                payload: json!({ "clusterId": key.0, "seq": r.seq, "reach": r }),
            });
        }
        self.fleet.wake.notify_one();
    }

    /// A request that changed something: re-read what it changed, shortly.
    pub(crate) fn fleet_invalidate(&self, cluster: &str, method: &str, path: &str) {
        let ds = catalogue::datasets_for_write(method, path);
        if ds.is_empty() {
            return;
        }
        let at = now_ms() + scheduler::AFTER_WRITE_MS;
        {
            let mut st = self.fleet.state.lock();
            for d in ds {
                st.request((cluster.to_string(), d), at);
            }
        }
        self.fleet.wake.notify_one();
    }

    /// Datasets waiting at priority 0 for a cluster. For tests.
    #[doc(hidden)]
    pub fn fleet_pending(&self, cluster: &str) -> Vec<String> {
        let st = self.fleet.state.lock();
        let mut v: Vec<String> = st.pending.keys().filter(|(c, _)| c == cluster).map(|(_, d)| d.name().to_string()).collect();
        v.sort();
        v
    }

    /* ---------------------------------- messages ---------------------------------- */

    /// The clusters this caller may see that the core actually has.
    fn fleet_visible(&self, caller: Option<&Caller>) -> Vec<String> {
        let vis = self.visible_ids(caller);
        let mut ids: Vec<String> = self.all_specs().into_iter().map(|s| s.id)
            .filter(|id| vis.as_ref().is_none_or(|v| v.contains(id))).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// `FLEET_STATE {since?, include?}`.
    pub(crate) fn fleet_state_msg(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let since = msg.get("since").and_then(Value::as_u64);
        let guest = is_guest(caller);
        let include: Vec<Dataset> = dataset_list(msg.get("include")).unwrap_or_else(background)
            .into_iter().filter(|d| !guest || d.guest_may_read()).collect();
        let ids = self.fleet_visible(caller);
        let now = now_ms();
        let hs = self.fleet.cfg.health_secs;
        let mut st = self.fleet.state.lock();
        st.last_activity = now;
        let mut clusters = Map::new();
        for id in &ids {
            let reach = st.reach.get(id).cloned().unwrap_or_default();
            let first = st.first_due.get(id).copied();
            let mut datasets = Map::new();
            for d in &include {
                let key = (id.clone(), *d);
                match st.entries.get_mut(&key) {
                    Some(e) => {
                        if since.is_none_or(|s| e.seq > s) {
                            e.last_read = now;
                            datasets.insert(d.name().into(), serde_json::to_value(&*e).unwrap_or(Value::Null));
                        }
                    }
                    // A background dataset not fetched yet is worth saying so about; an
                    // on-demand one nobody has asked for is simply not there.
                    None if since.is_none() && d.class() == Class::Background => {
                        datasets.insert(d.name().into(), serde_json::to_value(Entry::never(d.stale_after_ms(hs), first)).unwrap_or(Value::Null));
                    }
                    None => {}
                }
            }
            if since.is_none_or(|s| reach.seq > s) || !datasets.is_empty() {
                clusters.insert(id.clone(), json!({ "reach": reach, "datasets": datasets }));
            }
        }
        json!({
            "ok": true, "epoch": self.fleet.epoch, "seq": st.seq, "now": now, "running": self.fleet_enabled(),
            "full": since.is_none(),
            "catalogue": catalogue::catalogue_json(hs),
            "clusterIds": ids,
            "clusters": clusters,
        })
    }

    /// `CLUSTER_DATASET {clusterId, dataset, maxAgeSec?, wait?}`. The gate has already
    /// decided the caller may see this cluster.
    pub(crate) async fn cluster_dataset_msg(self: &Arc<Self>, msg: &Value, caller: Option<&Caller>) -> Value {
        let id = msg.get("clusterId").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(ds) = msg.get("dataset").and_then(Value::as_str).and_then(Dataset::parse) else {
            return json!({ "ok": false, "kind": "bad_request",
                           "message": format!("unknown dataset {:?}", msg.get("dataset")) });
        };
        if is_guest(caller) && !ds.guest_may_read() {
            return json!({ "ok": false, "kind": "forbidden", "role": "guest",
                           "message": format!("the guest role can see cluster health only, not {}", ds.name()) });
        }
        if self.spec_for(&id).is_none() {
            return json!({ "ok": false, "kind": "not_found", "message": format!("no cluster {id:?}") });
        }
        if !self.fleet_enabled() {
            return json!({ "ok": false, "kind": "fleet_off",
                           "message": "the fleet cache is not running in this core; ask the cluster directly" });
        }
        let hs = self.fleet.cfg.health_secs;
        let wait = match msg.get("wait") {
            Some(Value::Bool(true)) => MAX_WAIT,
            Some(Value::Number(n)) => Duration::from_secs(n.as_u64().unwrap_or(0)).min(MAX_WAIT),
            _ => Duration::ZERO,
        };
        let max_age_ms = msg.get("maxAgeSec").and_then(Value::as_u64).unwrap_or(ds.interval_secs(hs)) * 1000;
        let key = (id.clone(), ds);
        let now = now_ms();
        let rx = {
            let mut st = self.fleet.state.lock();
            st.last_activity = now;
            st.watched.insert(key.clone(), now);
            let fresh = st.entries.get(&key).is_some_and(|e| {
                e.status == Status::Ok && e.fetched_at.is_some_and(|t| now.saturating_sub(t) <= max_age_ms)
            }) && !st.pending.contains_key(&key);
            // A cluster that does not answer is not asked again for this: its health
            // probe is already scheduled, and waiting would only hold the page open.
            let unreachable = st.reach_state(&id) == ReachState::Unreachable && ds != Dataset::Health;
            if fresh || unreachable {
                None
            } else {
                if !st.inflight.contains_key(&key) {
                    // A request held open for this answer goes ahead of the queue.
                    if wait.is_zero() {
                        st.request(key.clone(), now);
                    } else {
                        st.request_first(key.clone());
                    }
                }
                if wait.is_zero() {
                    None
                } else {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    st.waiters.entry(key.clone()).or_default().push(tx);
                    Some(rx)
                }
            }
        };
        self.fleet.wake.notify_one();
        let waited = rx.is_some();
        let timed_out = match rx {
            Some(rx) => tokio::time::timeout(wait, rx).await.is_err(),
            None => false,
        };
        let mut st = self.fleet.state.lock();
        let reach = st.reach.get(&id).cloned().unwrap_or_default();
        let entry = match st.entries.get_mut(&key) {
            Some(e) => {
                e.last_read = now_ms();
                serde_json::to_value(&*e).unwrap_or(Value::Null)
            }
            None => serde_json::to_value(Entry::never(ds.stale_after_ms(hs), None)).unwrap_or(Value::Null),
        };
        json!({ "ok": true, "clusterId": id, "dataset": ds.name(), "entry": entry, "reach": reach,
                "waited": waited, "timedOut": timed_out })
    }

    /// `REFRESH {clusterIds?: [..] | "all", datasets?: [..]}`: go now, rather than when
    /// due. The gate has already checked every named cluster is the caller's.
    pub(crate) fn refresh_msg(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let visible = self.fleet_visible(caller);
        let ids: Vec<String> = match msg.get("clusterIds") {
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from))
                .filter(|id| visible.contains(id)).collect(),
            _ => visible,
        };
        let datasets = dataset_list(msg.get("datasets")).unwrap_or_else(background);
        let user = caller.map(|c| c.name.clone()).unwrap_or_default();
        let now = now_ms();
        let mut queued = 0;
        let mut skipped = vec![];
        {
            let mut st = self.fleet.state.lock();
            st.last_activity = now;
            st.refresh_rl.retain(|_, t| now.saturating_sub(*t) < scheduler::REFRESH_EVERY_MS);
            for id in &ids {
                let unreachable = st.reach_state(id) == ReachState::Unreachable;
                for d in &datasets {
                    // Down is down: one probe answers for all of it.
                    if unreachable && *d != Dataset::Health {
                        skipped.push(json!({ "clusterId": id, "dataset": d.name(), "reason": "unreachable" }));
                        continue;
                    }
                    let rl = (user.clone(), id.clone(), *d);
                    if st.refresh_rl.contains_key(&rl) {
                        skipped.push(json!({ "clusterId": id, "dataset": d.name(), "reason": "rate_limited" }));
                        continue;
                    }
                    st.refresh_rl.insert(rl, now);
                    if d.class() == Class::OnDemand {
                        st.watched.insert((id.clone(), *d), now);
                    }
                    st.request((id.clone(), *d), now);
                    queued += 1;
                }
            }
        }
        self.fleet.wake.notify_one();
        json!({ "ok": true, "queued": queued, "skipped": skipped, "running": self.fleet_enabled() })
    }

    /* ------------------------------------ events ------------------------------------ */

    pub(crate) fn events_ticket_msg(&self, caller: Option<Caller>, reauth: Reauth) -> Value {
        self.fleet_touch();
        let t = self.fleet.tickets.issue(EventsOwner { caller, reauth });
        json!({ "ok": true, "ticket": t, "expiresInSec": events::TICKET_TTL.as_secs(),
                "path": format!("/events?ticket={t}") })
    }

    /// The owner of a ticket, once.
    pub fn redeem_events_ticket(&self, ticket: &str) -> Option<EventsOwner> {
        self.fleet.tickets.redeem(ticket)
    }

    /// Who the stream's owner is now: `None` when they no longer are anybody (signed out,
    /// timed out, token revoked, account removed), so the stream must close. A role or
    /// scope that changed takes effect here.
    pub fn events_revalidate(&self, owner: &EventsOwner) -> Option<Option<Caller>> {
        if !self.edition().uses_accounts() {
            return Some(None);
        }
        let c = match &owner.reauth {
            Reauth::Session(t) => self.sessions.peek(t)
                .map(|s| Caller { name: s.user, role: s.role, must_change: s.must_change, scope: s.scope }),
            Reauth::Token(secret) => self.caller_for_token(secret),
            Reauth::Proxy(name) => self.caller_for_proxy_user(name),
            Reauth::None => None,
        }?;
        if c.must_change {
            return None;
        }
        Some(Some(c))
    }

    pub fn fleet_subscribe(&self) -> broadcast::Receiver<FleetEvent> {
        self.fleet.events.subscribe()
    }

    /// Whether this caller may be told about this event: their cluster, and for a guest
    /// only the datasets a guest may read.
    pub fn fleet_event_visible(&self, caller: Option<&Caller>, ev: &FleetEvent) -> bool {
        if is_guest(caller) && ev.dataset.is_some_and(|d| !d.guest_may_read()) {
            return false;
        }
        let Some(spec) = self.spec_for(&ev.cluster_id) else { return false };
        caller.is_none_or(|c| c.sees(&spec.zabbix_groups))
    }
}
