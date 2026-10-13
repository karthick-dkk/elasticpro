//! The request log behind the Request Centre: every request the core sends is recorded,
//! carries an opaque id to Elasticsearch, and is reported back with its outcome.

mod support;

use elasticpro_core::auth::{Edition, DEFAULT_PASSWORD, DEFAULT_USER};
use elasticpro_core::Core;
use serde_json::json;
use support::{TempDir, TestServer};

async fn admin(c: &std::sync::Arc<Core>) -> String {
    let r = c.handle(json!({ "type": "LOGIN", "name": DEFAULT_USER, "password": DEFAULT_PASSWORD })).await;
    r["session"].as_str().expect("a session").to_string()
}

#[tokio::test]
async fn every_request_is_recorded_with_its_origin_and_outcome_and_carries_an_opaque_id() {
    let dir = TempDir::new("req-log");
    let a = TestServer::start().await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [{ "id": "w", "url": a.url(), "authHeader": "" }] })).await;

    let r = c.handle(json!({ "type": "ES", "session": s, "clusterId": "w", "method": "GET", "path": "/_cluster/health", "origin": "page:test" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let hit = a.last_hit().expect("the cluster was asked");
    let oid = hit.header("x-opaque-id").expect("X-Opaque-Id on the wire").to_string();
    assert!(oid.starts_with("elasticpro/"), "{oid}");
    assert!(oid.contains("/page:test/w/"), "who asked and which cluster are in the id: {oid}");

    let log = c.handle(json!({ "type": "REQUEST_LOG", "session": s })).await;
    assert_eq!(log["ok"], json!(true), "{log}");
    assert_eq!(log["inflight"].as_array().map(|v| v.len()), Some(0), "nothing left in flight: {log}");
    let recent = log["recent"].as_array().expect("recent");
    let mine = recent.iter().find(|r| r["path"] == json!("/_cluster/health")).expect("the request is in the log");
    assert_eq!(mine["cluster"], json!("w"));
    assert_eq!(mine["origin"], json!("page:test"));
    assert_eq!(mine["method"], json!("GET"));
    assert_eq!(mine["ok"], json!(true));
    assert_eq!(mine["status"], json!("200"));
    assert!(mine["ms"].as_u64().is_some() && mine["startedAt"].as_u64().unwrap_or(0) > 1_600_000_000_000, "{mine}");
    assert_eq!(oid.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()), mine["id"].as_u64(), "the opaque id ends in the record's number");

    // A request nobody labelled is still recorded, as the core's own.
    c.handle(json!({ "type": "ES", "session": s, "clusterId": "w", "method": "GET", "path": "/" })).await;
    let log = c.handle(json!({ "type": "REQUEST_LOG", "session": s, "limit": 1 })).await;
    assert_eq!(log["recent"][0]["origin"], json!("core"), "{log}");
    assert_eq!(log["recent"].as_array().map(|v| v.len()), Some(1), "limit is honoured");

    // Narrowed to a cluster that does not exist: empty, not an error.
    let none = c.handle(json!({ "type": "REQUEST_LOG", "session": s, "cluster": "nope" })).await;
    assert_eq!(none["recent"].as_array().map(|v| v.len()), Some(0));
}

#[tokio::test]
async fn a_request_that_fails_is_recorded_with_why() {
    let dir = TempDir::new("req-log-fail");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [{ "id": "dead", "url": "http://127.0.0.1:9", "authHeader": "" }] })).await;
    let r = c.handle(json!({ "type": "ES", "session": s, "clusterId": "dead", "method": "GET", "path": "/", "origin": "page:test" })).await;
    assert_eq!(r["ok"], json!(false));
    let log = c.handle(json!({ "type": "REQUEST_LOG", "session": s, "cluster": "dead" })).await;
    let rec = &log["recent"][0];
    assert_eq!(rec["ok"], json!(false), "{log}");
    assert!(rec["status"].as_str().is_some_and(|k| !k.is_empty() && k != "200"), "the core's own kind stands in for a status: {rec}");
}
