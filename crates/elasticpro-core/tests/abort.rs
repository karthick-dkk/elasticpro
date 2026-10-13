//! Letting go of a page's requests when the page is left, and cancelling a task on the
//! cluster — the one under the write guard, the other never touching the cluster at all.

mod support;

use elasticpro_core::auth::{authorize, Edition, Role};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{TempDir, TestServer};

async fn primed(dir: &TempDir, url: &str, read_only: bool) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": read_only, "clusters": [{ "id": "es", "url": url }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c
}

fn es(origin: &str, path: &str) -> Value {
    json!({ "type": "ES", "clusterId": "es", "method": "GET", "path": path, "origin": origin, "timeoutMs": 15000 })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leaving_the_page_answers_its_waiting_requests_as_aborted_instead_of_timing_out() {
    let dir = TempDir::new("abort-page");
    let srv = TestServer::stall().await;              // accepts, never answers
    let c = primed(&dir, &srv.url(), true).await;
    let c2 = c.clone();
    let waiting = tokio::spawn(async move { c2.handle(es("page:indices", "/_cat/indices")).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t0 = Instant::now();
    let a = c.handle(json!({ "type": "ABORT_REQUESTS", "origin": "page:indices" })).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    assert_eq!(a["aborted"], json!(1), "one request was waiting: {a}");
    let r = tokio::time::timeout(Duration::from_secs(3), waiting).await.expect("the request should stop waiting").unwrap();
    assert_eq!(r["ok"], json!(false));
    assert_eq!(r["kind"], json!("aborted"), "{r}");
    assert!(t0.elapsed() < Duration::from_secs(2), "answered at once, not at the 15 s timeout");
    let log = c.handle(json!({ "type": "REQUEST_LOG" })).await;
    let recent = log["recent"].as_array().unwrap();
    assert!(recent.iter().any(|x| x["origin"] == json!("page:indices") && x["status"] == json!("aborted")), "{log}");
    assert_eq!(log["inflight"].as_array().unwrap().len(), 0, "nothing left in flight: {log}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_abort_reaches_only_its_own_origin_and_never_the_poller() {
    let dir = TempDir::new("abort-scope");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;
    let (c2, c3) = (c.clone(), c.clone());
    let other = tokio::spawn(async move { c2.handle(es("page:shards", "/_cat/shards")).await });
    let poller = tokio::spawn(async move { c3.handle(es("poller:health", "/_cluster/health")).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a = c.handle(json!({ "type": "ABORT_REQUESTS", "origin": "page:indices" })).await;
    assert_eq!(a["aborted"], json!(0), "nothing of that origin was waiting: {a}");
    let p = c.handle(json!({ "type": "ABORT_REQUESTS", "origin": "poller:health" })).await;
    assert_eq!(p["ok"], json!(false), "the poller's requests are not a page's to abort: {p}");
    assert_eq!(p["kind"], json!("bad_request"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!other.is_finished() && !poller.is_finished(), "both are still waiting on the cluster");
    other.abort();
    poller.abort();
}

#[tokio::test]
async fn cancelling_a_task_is_a_write_blocked_until_both_gates_open() {
    let dir = TempDir::new("abort-cancel");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    let cancel = || json!({ "type": "ES", "clusterId": "es", "method": "POST", "path": "/_tasks/node-1:4711/_cancel",
                            "origin": "page:requests", "allowWrites": true });
    let r = c.handle(cancel()).await;
    assert_eq!(r["kind"], json!("blocked_readonly"), "read-only config: {r}");
    assert_eq!(srv.connections(), 0, "a blocked cancel never opens a socket");
    let u = c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;
    assert_eq!(u["ok"], json!(true), "{u}");
    let r = c.handle(json!({ "type": "ES", "clusterId": "es", "method": "POST", "path": "/_tasks/node-1:4711/_cancel", "origin": "page:requests" })).await;
    assert_eq!(r["kind"], json!("blocked_readonly"), "unlocked, but not asked for by hand: {r}");
    let r = c.handle(cancel()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let hit = srv.last_hit().unwrap();
    assert_eq!((hit.method.as_str(), hit.path.as_str()), ("POST", "/_tasks/node-1:4711/_cancel"));
    assert!(hit.header("x-opaque-id").unwrap().contains("/page:requests/es/"), "{:?}", hit.headers);
}

#[test]
fn aborting_ones_own_requests_takes_a_signed_in_user() {
    assert!(authorize(Role::User, "ABORT_REQUESTS", "", "").is_ok());
    assert!(authorize(Role::Guest, "ABORT_REQUESTS", "", "").is_err());
}
