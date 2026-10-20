//! The outgoing gate, end to end: what reaches a cluster, and what never does.
//!
//! Every case drives `Core::handle` against a loopback server that counts what it is
//! holding, so "never more than four at once" and "nothing was sent" are measured on the
//! server's side of the socket, not inferred from the core's bookkeeping.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::gate::{Limits, RequestConfig};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use support::{GaugedServer, TempDir, TestServer};

async fn primed(dir: &TempDir, url: &str, read_only: bool) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": read_only, "clusters": [{ "id": "es", "url": url }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c
}

fn get(path: &str, origin: &str) -> Value {
    json!({ "type": "ES", "clusterId": "es", "method": "GET", "path": path, "origin": origin, "timeoutMs": 15000 })
}

fn cfg(f: impl FnOnce(&mut RequestConfig)) -> RequestConfig {
    let mut c = elasticpro_core::gate::config().clone();
    f(&mut c);
    c.limits = c.limits.normalised();
    c
}

/// Wait (up to twenty seconds: the first client of a core loads the OS certificate store,
/// which is slow on a busy machine) for something that happens on another task.
async fn until(f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn log(c: &Arc<Core>) -> Value {
    c.handle(json!({ "type": "REQUEST_LOG", "limit": 2000 })).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hundred_requests_to_one_cluster_never_hold_more_than_four_connections() {
    let dir = TempDir::new("gate-cap");
    let srv = GaugedServer::start(|_| (200, r#"{"ok":1}"#.into(), 40)).await;
    let c = primed(&dir, &srv.url(), true).await;
    // Room in the queue for all of them: this is about the per-cluster cap, not the bound.
    c.set_request_config_for_tests(cfg(|r| { r.limits.queue_per_user = 200; r.limits.queue_max = 200; r.read_cache_secs = 0; }));
    assert_eq!(c.request_config().limits.per_cluster, 4, "the shipped per-cluster cap");
    let mut all = Vec::new();
    for i in 0..100 {
        let c = c.clone();
        // Distinct paths, so none of them is shared with another.
        all.push(tokio::spawn(async move { c.handle(get(&format!("/_cat/indices?i={i}"), "page:indices")).await }));
    }
    let mut ok = 0;
    for h in all {
        let r = h.await.unwrap();
        if r["ok"] == json!(true) { ok += 1; } else { panic!("{r}"); }
    }
    assert_eq!(ok, 100);
    assert_eq!(srv.hits().len(), 100);
    assert!(srv.peak() <= 4, "the cluster held {} at once", srv.peak());
    assert!(srv.peak() >= 2, "they did run side by side: {}", srv.peak());
    let l = log(&c).await;
    assert_eq!(l["inflight"].as_array().unwrap().len(), 0);
    assert!(l["recent"].as_array().unwrap().iter().any(|r| r["queuedMs"].as_u64().unwrap_or(0) > 0), "some had to wait their turn");
    assert_eq!(c.gate_counts(), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_queue_is_refused_at_once_with_ep_214_and_nothing_is_sent() {
    let dir = TempDir::new("gate-full");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.limits.global = 1; r.limits.background_reserve = 0; r.limits.queue_max = 2; r.limits.queue_per_user = 2; r.read_cache_secs = 0; }));
    let mut held = Vec::new();
    for i in 0..3 {
        let c = c.clone();
        held.push(tokio::spawn(async move { c.handle(get(&format!("/slow/{i}"), "page:a")).await }));
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    assert_eq!(c.gate_counts(), (1, 2), "one running, two waiting");
    // The first client of a core loads the OS certificate store, which takes a moment.
    until(|| srv.connections() == 1).await;
    let t0 = std::time::Instant::now();
    let r = c.handle(get("/one-too-many", "page:a")).await;
    assert!(t0.elapsed() < Duration::from_secs(1), "refused at once, not after waiting");
    assert_eq!(r["kind"], json!("overloaded"), "{r}");
    assert_eq!(r["errorCode"], json!("EP-214"));
    assert!(r["message"].as_str().unwrap().ends_with("(EP-214)"));
    assert!(r["retryAfterMs"].as_u64().is_some_and(|ms| (1000..=10_000).contains(&ms)), "{r}");
    assert_eq!(srv.connections(), 1, "only the running one ever reached the cluster");
    let l = log(&c).await;
    assert!(l["recent"].as_array().unwrap().iter().any(|x| x["path"] == json!("/one-too-many") && x["status"] == json!("overloaded")), "the refusal is in the Request Centre");
    assert_eq!(l["gate"]["queued"]["total"], json!(2));
    assert_eq!(l["gate"]["refused"]["overloaded"], json!(1));
    for h in held { h.abort(); }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waiter_past_the_queue_wait_is_answered_queue_timeout_with_ep_215() {
    let dir = TempDir::new("gate-wait");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.limits.global = 1; r.limits.background_reserve = 0; r.limits.queue_wait_ms = 300; r.read_cache_secs = 0; }));
    let c2 = c.clone();
    let first = tokio::spawn(async move { c2.handle(get("/hold", "page:a")).await });
    tokio::time::sleep(Duration::from_millis(80)).await;
    let r = c.handle(get("/wait", "page:a")).await;
    assert_eq!(r["kind"], json!("queue_timeout"), "{r}");
    assert_eq!(r["errorCode"], json!("EP-215"));
    assert!(r["queuedMs"].as_u64().unwrap_or(0) >= 280, "{r}");
    until(|| srv.connections() >= 1).await;
    assert_eq!(srv.connections(), 1);
    first.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_a_waiter_never_reaches_the_server() {
    let dir = TempDir::new("gate-abort");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.limits.per_cluster = 1; r.read_cache_secs = 0; }));
    let (c1, c2) = (c.clone(), c.clone());
    let holder = tokio::spawn(async move { c1.handle(get("/hold", "page:shards")).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let waiting = tokio::spawn(async move { c2.handle(get("/queued", "page:indices")).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let l = log(&c).await;
    assert!(l["inflight"].as_array().unwrap().iter().any(|r| r["path"] == json!("/queued") && r["state"] == json!("queued")), "a waiting request is visible: {l}");
    let a = c.handle(json!({ "type": "ABORT_REQUESTS", "origin": "page:indices" })).await;
    assert_eq!(a["aborted"], json!(1), "a queued request can be aborted: {a}");
    let r = tokio::time::timeout(Duration::from_secs(3), waiting).await.expect("answered").unwrap();
    assert_eq!(r["kind"], json!("aborted"), "{r}");
    until(|| srv.connections() >= 1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(srv.connections(), 1, "the aborted waiter never opened a socket");
    assert_eq!(c.gate_counts(), (1, 0), "and left the queue");
    holder.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_client_leaves_nothing_in_flight_waiting_or_sending() {
    let dir = TempDir::new("gate-drop");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.limits.per_cluster = 1; r.read_cache_secs = 0; }));
    let (c1, c2) = (c.clone(), c.clone());
    // One at the cluster, one waiting for its slot; then both clients go away.
    let mut m = get("/sending", "page:logs");
    m["timeoutMs"] = json!(2000);
    let sending = tokio::spawn(async move { c1.handle(m).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let waiting = tokio::spawn(async move { c2.handle(get("/waiting", "page:logs")).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(c.gate_counts(), (1, 1));
    sending.abort();
    waiting.abort();
    let _ = (sending.await, waiting.await);
    // A request that others could have shared runs as its own task; the last waiter
    // leaving cancels it, which takes effect the next time the runtime polls it.
    until(|| c.gate_counts().1 == 0).await;
    let l = log(&c).await;
    assert_eq!(l["inflight"].as_array().unwrap().len(), 0, "no ghost rows: {l}");
    let recent = l["recent"].as_array().unwrap();
    for p in ["/sending", "/waiting"] {
        let r = recent.iter().find(|r| r["path"] == json!(p)).unwrap_or_else(|| panic!("{p} not recorded: {l}"));
        assert_eq!(r["status"], json!("client_gone"), "{r}");
    }
    // The queue is empty at once. The request the cluster is still working on keeps its slot
    // until the cluster answers or its own timeout passes: the gate counts what the cluster
    // carries, not only what somebody here still waits for.
    assert_eq!(c.gate_counts().1, 0, "the waiter left the queue");
    until(|| c.gate_counts() == (0, 0)).await;
    assert_eq!(c.gate_counts(), (0, 0), "the slot came back when the request timed out at the cluster");
    assert_eq!(srv.connections(), 1, "the waiter never reached the cluster");
    let a = c.handle(json!({ "type": "ABORT_REQUESTS", "origin": "page:logs" })).await;
    assert_eq!(a["aborted"], json!(0), "the abort registrations were counted out: {a}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn five_people_asking_the_same_at_once_cost_the_cluster_one_request() {
    let dir = TempDir::new("gate-share");
    let srv = GaugedServer::start(|_| (200, r#"{"status":"green"}"#.into(), 300)).await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let admin = Caller { name: "admin".into(), role: Role::Admin, must_change: false, scope: None };
    let r = c.handle_as(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "es", "url": srv.url(), "authHeader": "Basic c2hhcmVk" }] }), Some(admin)).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    // Cache off: this is single-flight alone.
    c.set_request_config_for_tests(cfg(|r| r.read_cache_secs = 0));
    let mut all = Vec::new();
    for i in 0..5 {
        let c = c.clone();
        let who = Caller { name: format!("user{i}"), role: Role::User, must_change: false, scope: None };
        all.push(tokio::spawn(async move { c.handle_as(get("/_cluster/health", "page:overview"), Some(who)).await }));
    }
    let mut shared = 0;
    for h in all {
        let r = h.await.unwrap();
        assert_eq!(r["ok"], json!(true), "{r}");
        assert_eq!(r["json"]["status"], json!("green"));
        if r["shared"] == json!(true) { shared += 1; }
    }
    assert_eq!(srv.hits().len(), 1, "one request reached the cluster");
    assert_eq!(shared, 4);
    let l = c.handle_as(json!({ "type": "REQUEST_LOG" }), Some(Caller { name: "admin".into(), role: Role::Admin, must_change: false, scope: None })).await;
    let recent = l["recent"].as_array().unwrap();
    assert_eq!(recent.iter().filter(|r| r["shared"] == json!(true)).count(), 4, "{l}");
    assert_eq!(l["gate"]["shared"], json!(4));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_with_its_own_credential_is_never_shared_or_cached() {
    let dir = TempDir::new("gate-own-auth");
    let srv = GaugedServer::start(|_| (200, r#"{"status":"green"}"#.into(), 200)).await;
    let c = primed(&dir, &srv.url(), true).await;
    let mut all = Vec::new();
    for _ in 0..3 {
        let c = c.clone();
        let mut m = get("/_cluster/health", "page:overview");
        m["authHeader"] = json!("Basic b3RoZXI=");
        all.push(tokio::spawn(async move { c.handle(m).await }));
    }
    for h in all {
        let r = h.await.unwrap();
        assert_eq!(r["ok"], json!(true), "{r}");
        assert!(r.get("shared").is_none() && r.get("cached").is_none(), "{r}");
    }
    assert_eq!(srv.hits().len(), 3, "each went on its own");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_read_cache_answers_a_repeat_and_a_write_or_a_reload_goes_past_it() {
    let dir = TempDir::new("gate-cache");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), false).await; // writes allowed by config
    c.set_request_config_for_tests(cfg(|r| r.read_cache_secs = 30));
    let a = c.handle(get("/_cat/indices", "page:indices")).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    let b = c.handle(get("/_cat/indices", "page:indices")).await;
    assert_eq!(b["cached"], json!(true), "{b}");
    assert!(b["ageMs"].as_u64().is_some());
    assert_eq!(srv.hits().len(), 1, "the repeat was answered from memory");
    let mut reload = get("/_cat/indices", "page:indices");
    reload["maxAgeMs"] = json!(0);
    let r = c.handle(reload).await;
    assert!(r.get("cached").is_none(), "Reload asks the cluster: {r}");
    assert_eq!(srv.hits().len(), 2);
    let console = c.handle(get("/_cat/indices", "console")).await;
    assert!(console.get("cached").is_none(), "the console always asks the cluster");
    assert_eq!(srv.hits().len(), 3);
    let w = c.handle(json!({ "type": "ES", "clusterId": "es", "method": "PUT", "path": "/new-index", "origin": "console" })).await;
    assert_eq!(w["ok"], json!(true), "{w}");
    let after = c.handle(get("/_cat/indices", "page:indices")).await;
    assert!(after.get("cached").is_none(), "a write emptied the cache for the cluster: {after}");
    assert_eq!(srv.hits().len(), 5);
    let l = log(&c).await;
    assert!(l["recent"].as_array().unwrap().iter().any(|r| r["cached"] == json!(true)), "the cache hit is in the Request Centre");
    assert!(l["gate"]["cacheHits"].as_u64().unwrap_or(0) >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_over_the_cap_is_refused_with_ep_216_without_reading_it_all() {
    let dir = TempDir::new("gate-big");
    // 200 MB, chunked: the length is not known until it has been read.
    let (port, sent) = support::endless_body(200 * 1024 * 1024, false).await;
    let c = primed(&dir, &format!("http://127.0.0.1:{port}"), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.max_response_bytes = 8 * 1024 * 1024; r.read_cache_secs = 0; }));
    let r = c.handle(json!({ "type": "ES", "clusterId": "es", "method": "GET", "path": "/_cat/indices", "origin": "page:indices", "timeoutMs": 60000 })).await;
    assert_eq!(r["kind"], json!("response_too_large"), "{r}");
    assert_eq!(r["errorCode"], json!("EP-216"));
    assert!(r["help"].as_str().unwrap().contains("ES_MAX_RESPONSE_MB"), "{r}");
    assert!(r.get("json").is_none() && r.get("text").is_none(), "nothing of a cut answer is passed on");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let written = sent.load(std::sync::atomic::Ordering::SeqCst);
    assert!(written < 64 * 1024 * 1024, "the core stopped reading; the server got {} MB out", written / (1024 * 1024));
    let l = log(&c).await;
    assert_eq!(l["gate"]["bodyBudget"]["inUseBytes"], json!(0), "the byte budget was given back");

    // Declared up front: refused before a byte of the body is read.
    let (port2, sent2) = support::endless_body(200 * 1024 * 1024, true).await;
    let c2 = primed(&TempDir::new("gate-big2"), &format!("http://127.0.0.1:{port2}"), true).await;
    let r = c2.handle(get("/_search", "page:logs")).await;
    assert_eq!(r["kind"], json!("response_too_large"), "{r}");
    assert_eq!(r["declaredBytes"], json!(200u64 * 1024 * 1024));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(sent2.load(std::sync::atomic::Ordering::SeqCst) < 64 * 1024 * 1024);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_poller_s_datasets_get_the_higher_cap() {
    // A page may bring back 1 MB here, the poller 64: a 4 MB answer is refused to one and
    // read for the other.
    let dir = TempDir::new("gate-fleet-cap");
    let (port, _) = support::endless_body(4 * 1024 * 1024, true).await;
    let c = primed(&dir, &format!("http://127.0.0.1:{port}"), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.max_response_bytes = 1024 * 1024; r.max_fleet_response_bytes = 64 * 1024 * 1024; r.read_cache_secs = 0; }));
    let page = c.handle(get("/_cat/indices?format=json", "poller:indices")).await;
    assert_eq!(page["kind"], json!("response_too_large"), "an ES message is a person's, whatever its origin says: {page}");
    let poller = c.es_req_as(elasticpro_core::http::EsRequest {
        cluster_id: "es".into(), path: "/_cat/indices?format=json".into(), origin: Some("poller:indices".into()),
        class: elasticpro_core::gate::Class::Background, ..Default::default()
    }).await;
    assert_eq!(poller["ok"], json!(true), "{}", poller["message"]);
    assert_eq!(poller["bytes"], json!(4 * 1024 * 1024));
}

fn tasks_listing(instance: &str, orphan_n: u64, inflight_n: u64) -> String {
    let t = |id: u64, action: &str, opaque: &str| json!({ "node": "nodeA", "id": id, "action": action, "running_time_in_nanos": 90_000_000_000u64,
                                                          "cancellable": true, "headers": { "X-Opaque-Id": opaque } });
    json!({ "tasks": [
        t(1, "indices:data/read/search", &format!("elasticpro/{instance}/page:logs/es/{orphan_n}")),
        t(2, "indices:data/read/search", &format!("elasticpro/{instance}/page:logs/es/{inflight_n}")),
        t(3, "indices:data/write/reindex", &format!("elasticpro/{instance}/console/es/{orphan_n}")),
        t(4, "indices:data/read/search", "kibana-report-77"),
        t(5, "indices:data/read/search", "elasticpro/prev0001/poller:health/es/9"),
        t(6, "indices:data/read/search", "elasticpro/stranger/page:logs/es/9"),
    ] }).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_task_reaper_cancels_only_our_orphaned_read_tasks() {
    let dir = TempDir::new("gate-reaper");
    // The run before this one, with a read out on "es" when it stopped.
    std::fs::write(dir.join("instance.json"), r#"{"current":"prev0001","clusters":["es"]}"#).unwrap();
    let listing = Arc::new(std::sync::Mutex::new(String::from(r#"{"tasks":[]}"#)));
    let l2 = listing.clone();
    let srv = GaugedServer::start(move |hit| {
        if hit.path.starts_with("/_tasks?") {
            (200, l2.lock().unwrap().clone(), 0)
        } else if hit.path.ends_with("/_cancel") {
            (200, r#"{"nodes":{}}"#.into(), 0)
        } else if hit.path == "/slow" {
            (200, "{}".into(), 3_000)
        } else if hit.path == "/held" {
            (200, "{}".into(), 4_000)
        } else {
            (200, "{}".into(), 0)
        }
    }).await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| r.read_cache_secs = 0));
    // A read that times out here while the cluster keeps going: the orphan.
    let mut slow = get("/slow", "page:logs");
    slow["timeoutMs"] = json!(200);
    let r = c.handle(slow).await;
    assert_eq!(r["kind"], json!("timeout"), "{r}");
    // A read still waited for: never touched.
    let c2 = c.clone();
    let held = tokio::spawn(async move { c2.handle(get("/held", "page:logs")).await });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let l = log(&c).await;
    let orphan_n = l["recent"].as_array().unwrap().iter().find(|r| r["path"] == json!("/slow")).unwrap()["id"].as_u64().unwrap();
    let inflight_n = l["inflight"].as_array().unwrap().iter().find(|r| r["path"] == json!("/held")).unwrap()["id"].as_u64().unwrap();
    assert_eq!(l["tasks"]["previousInstance"], json!("prev0001"));
    *listing.lock().unwrap() = tasks_listing(c.instance_id(), orphan_n, inflight_n);

    let out = c.reap_es_tasks().await;
    let cancels: Vec<String> = srv.hits().iter().filter(|h| h.path.ends_with("/_cancel")).map(|h| format!("{} {}", h.method, h.path)).collect();
    assert_eq!(cancels, vec!["POST /_tasks/nodeA:1/_cancel", "POST /_tasks/nodeA:5/_cancel"],
               "ours and orphaned (this run's, and the run before's) — not the one still waited for, not a write, not a stranger's: {out}");
    assert_eq!(out["cancelled"].as_array().unwrap().iter().filter(|x| x["ok"] == json!(true)).count(), 2, "{out}");
    let l = log(&c).await;
    let recent = l["recent"].as_array().unwrap();
    assert_eq!(recent.iter().find(|r| r["id"] == json!(orphan_n)).unwrap()["status"], json!("es_task_cancelled"), "the orphan's own row says what happened to it");
    assert!(recent.iter().any(|r| r["origin"] == json!("core:task-reaper") && r["method"] == json!("POST")), "the cancel itself is in the Request Centre");
    assert_eq!(l["gate"]["taskReaper"]["last"]["checked"], json!(1));
    c.flush_activity();
    let acts = c.handle(json!({ "type": "ACTIVITY_LIST", "limit": 100 })).await;
    let cancelled: Vec<&Value> = acts["events"].as_array().map(|a| a.iter().filter(|e| e["event"]["action"] == json!("es_task_cancelled")).collect()).unwrap_or_default();
    assert_eq!(cancelled.len(), 2, "every cancel is an activity event: {acts}");
    assert!(cancelled.iter().any(|e| e["event"]["reason"].as_str().unwrap_or("").contains(&format!("elasticpro/{}/page:logs/es/{orphan_n}", c.instance_id()))), "with the opaque id");

    // Clean now (the listing answers nothing of ours): the next pass has nowhere to look.
    *listing.lock().unwrap() = r#"{"tasks":[]}"#.into();
    let again = c.reap_es_tasks().await;
    assert_eq!(again["checked"], json!(1), "one more look at the cluster that had orphans: {again}");
    let quiet = c.reap_es_tasks().await;
    assert_eq!(quiet["checked"], json!(0), "and none after it came back clean: {quiet}");
    held.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_task_reaper_off_sends_nothing() {
    let dir = TempDir::new("gate-reaper-off");
    std::fs::write(dir.join("instance.json"), r#"{"current":"prev0002","clusters":["es"]}"#).unwrap();
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| r.task_reaper = elasticpro_core::gate::ReaperMode::Off));
    let out = c.reap_es_tasks().await;
    assert_eq!(out["mode"], json!("off"));
    assert_eq!(srv.connections(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timeout_above_the_ceiling_is_cut_to_it() {
    let dir = TempDir::new("gate-ceiling");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| r.limits = Limits { max_timeout_ms: 1_000, ..r.limits.clone() }));
    let r = c.handle(json!({ "type": "ES", "clusterId": "es", "method": "GET", "path": "/", "origin": "page:x", "timeoutMs": 600000 })).await;
    assert_eq!(r["kind"], json!("timeout"), "{r}");
    // Measured from the send, so a slow first certificate-store load does not count.
    assert!(r["tookMs"].as_u64().is_some_and(|ms| ms < 3_000), "given 1 s, not the 600 s it asked for: {r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_reaper_pass_leaves_a_healthy_core_alone() {
    let dir = TempDir::new("gate-reap");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.handle(get("/", "page:x")).await;
    assert_eq!(c.reap_requests(), 0, "nothing stuck, nothing reaped");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("instance.json")).unwrap()).unwrap();
    assert_eq!(file["current"], json!(c.instance_id()), "this run's id is on disk for the next one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reading_the_request_log_while_requests_share_never_locks_the_core_up() {
    // The Request Centre reads the log every two seconds while people's requests start,
    // join and finish flights. A lock taken in one order there and the other order here
    // once froze the whole core under load; this runs both sides hard, side by side.
    let dir = TempDir::new("gate-locks");
    let srv = GaugedServer::start(|_| (200, "{}".into(), 5)).await;
    let c = primed(&dir, &srv.url(), true).await;
    c.set_request_config_for_tests(cfg(|r| { r.read_cache_secs = 0; r.limits.queue_per_user = 1000; r.limits.queue_max = 1000; }));
    let work = async {
        let mut all = Vec::new();
        for i in 0..400 {
            let (c1, c2) = (c.clone(), c.clone());
            all.push(tokio::spawn(async move { c1.handle(get(&format!("/_cat/indices?k={}", i % 7), "page:indices")).await }));
            all.push(tokio::spawn(async move { c2.handle(json!({ "type": "REQUEST_LOG", "limit": 2000 })).await }));
        }
        for h in all {
            h.await.unwrap();
        }
    };
    tokio::time::timeout(Duration::from_secs(60), work).await.expect("the core answered everything: no lock-up");
    until(|| c.gate_counts() == (0, 0)).await;
    assert_eq!(log(&c).await["inflight"].as_array().unwrap().len(), 0);
}
