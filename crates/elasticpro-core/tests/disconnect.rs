//! A browser that goes away takes its request with it.
//!
//! The hosted core serves `/bridge` through axum on hyper. When the client closes its
//! connection — a tab closed, a page left with its AbortController fired, nginx giving up —
//! hyper drops the handler's future, and with it everything the request held: its slot at
//! the gate, its place in the queue, its abort registration. The record says `client_gone`.
//! This proves the first half (hyper drops the future) against a real server, because the
//! whole cleanup design rests on it.
#![cfg(feature = "bridge")]

mod support;

use axum::{extract::State, routing::post, Json, Router};
use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use support::{TempDir, TestServer};
use tokio::io::AsyncWriteExt;

async fn bridge(State(core): State<Arc<Core>>, Json(msg): Json<Value>) -> Json<Value> {
    Json(core.handle(msg).await)
}

async fn until(f: impl Fn() -> bool) -> bool {
    // Up to twenty seconds: the first client of a core loads the OS certificate store.
    for _ in 0..400 {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_the_connection_drops_the_request_at_the_cluster_and_in_the_queue() {
    let dir = TempDir::new("disconnect");
    let es = TestServer::stall().await;
    let core = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = core.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "es", "url": es.url() }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let mut cfg = core.request_config();
    cfg.limits.per_cluster = 1;
    cfg.read_cache_secs = 0;
    core.set_request_config_for_tests(cfg);

    let app = Router::new().route("/bridge", post(bridge)).with_state(core.clone());
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    let send = |path: &str| {
        let body = json!({ "type": "ES", "clusterId": "es", "method": "GET", "path": path, "origin": "page:logs", "timeoutMs": 2000 }).to_string();
        format!("POST /bridge HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    };
    // One request at the cluster, one waiting for its slot behind it.
    let mut a = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    a.write_all(send("/at-the-cluster").as_bytes()).await.unwrap();
    assert!(until(|| es.connections() == 1).await, "the first request reached the cluster");
    let mut b = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    b.write_all(send("/in-the-queue").as_bytes()).await.unwrap();
    assert!(until(|| core.gate_counts() == (1, 1)).await, "one running, one queued: {:?}", core.gate_counts());

    // Both clients go away without reading an answer.
    drop(a);
    drop(b);
    assert!(until(|| core.gate_counts().1 == 0).await, "hyper dropped the waiting future: the queue is empty ({:?})", core.gate_counts());
    let log = core.handle(json!({ "type": "REQUEST_LOG" })).await;
    assert_eq!(log["inflight"].as_array().unwrap().len(), 0, "{log}");
    for p in ["/at-the-cluster", "/in-the-queue"] {
        let rec = log["recent"].as_array().unwrap().iter().find(|r| r["path"] == json!(p)).cloned().unwrap_or(Value::Null);
        assert_eq!(rec["status"], json!("client_gone"), "{p}: {rec}");
    }
    // The one at the cluster keeps its slot until the cluster answers or its timeout passes —
    // the cluster is still working on it, whoever stopped waiting.
    assert!(until(|| core.gate_counts() == (0, 0)).await, "the slot came back at the request's timeout ({:?})", core.gate_counts());
    assert_eq!(es.connections(), 1, "the queued request never reached the cluster");
}
