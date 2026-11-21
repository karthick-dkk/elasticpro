//! A run's details and the slow searches (docs/JOBS.md "Run details", "Slow searches") through
//! the real message API: `JOB_RUN_DETAIL` gives a finished log delay run's per-cluster parts
//! and its own lines to whoever may list the run, and `SLOW_SEARCHES` reads `_tasks` once per
//! cluster, labels ElasticPro's own searches and refuses a threshold it does not offer.
//!
//! The rules themselves (error codes, bounds, capture, narrowing) are proved in
//! `jobs/detail.rs`, `jobs/capture.rs` and `jobs/mod.rs`.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::worker::Role;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{GaugedServer, TempDir};

const PASSWORD: &str = "correct-horse-battery";

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": &s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn user(c: &Arc<Core>, s: &str, name: &str, role: &str) -> String {
    let r = c.handle(json!({ "type": "USER_ADD", "session": s, "name": name, "password": PASSWORD, "role": role })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    res["session"].as_str().unwrap_or_else(|| panic!("a session: {res}")).to_string()
}

/// A cluster that answers the delay search with one device, takes a bulk, and lists two
/// searches in `_tasks`: one of ElasticPro's (95 s) and somebody else's (42 s).
async fn cluster() -> GaugedServer {
    cluster_taking(0).await
}

/// The same cluster, its `_tasks` answer taking `tasks_ms`.
async fn cluster_taking(tasks_ms: u64) -> GaugedServer {
    GaugedServer::start(move |hit| {
        if hit.path.starts_with("/_bulk") {
            return (200, r#"{"took":3,"errors":false,"items":[{"index":{"status":201}}]}"#.into(), 0);
        }
        if hit.path.starts_with("/_tasks") {
            let body = json!({ "nodes": { "n1": { "name": "es-data-3", "tasks": {
                "n1:11": { "node": "n1", "id": 11, "action": "indices:data/read/search", "running_time_in_nanos": 95_000_000_000u64,
                           "description": "indices[logstash-*], search_type[QUERY_THEN_FETCH], source[{\"size\":0}]",
                           "headers": { "X-Opaque-Id": "elasticpro/abcd/core:logdelay/prod/4" } },
                "n1:12": { "node": "n1", "id": 12, "action": "indices:data/read/search", "running_time_in_nanos": 42_000_000_000u64,
                           "description": "indices[metrics-*], search_type[QUERY_THEN_FETCH]", "headers": { "X-Opaque-Id": "kibana-7f" } },
            } } } });
            return (200, body.to_string(), tasks_ms);
        }
        let body = json!({ "took": 5, "aggregations": { "devices": { "buckets": [
            { "key": "fw-1", "doc_count": 120, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:41:00Z", "ingested_time": "2026-09-19T12:00:00Z" } },
            ] } } },
        ] } } });
        (200, body.to_string(), 0)
    })
    .await
}

#[tokio::test]
async fn a_finished_runs_parts_and_lines_are_read_on_expand_by_who_may_list_it() {
    let dir = TempDir::new("job-detail");
    let srv = cluster().await;
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, Role::All);
    let s = admin(&c).await;
    let res = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": false, "clusters": [
        { "id": "prod", "url": srv.url() }, { "id": "kibana", "url": srv.url() },
    ] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let res = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": {
        "enabled": true, "destination": "cluster", "sinkClusterId": "kibana", "everyHours": 2,
        "indexPrefix": "elasticpro-log-delay", "indexPattern": "logstash-*" } })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await["ok"], json!(true));
    let list = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    let run = list["runs"][0].clone();
    assert_eq!(run["jobId"], json!("logdelay.measure"), "{list}");
    assert_eq!(run["parts"], json!({ "succeeded": 1, "partial": 0, "failed": 0, "deferred": 0, "skipped": 0 }), "{run}");
    let id = run["id"].as_str().unwrap().to_string();

    let u = user(&c, &s, "user1", "user").await;
    let d = c.handle(json!({ "type": "JOB_RUN_DETAIL", "session": &u, "runId": &id })).await;
    assert_eq!(d["ok"], json!(true), "{d}");
    assert_eq!(d["run"]["id"], json!(id));
    let parts = d["detail"]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!((parts[0]["cluster"].clone(), parts[0]["status"].clone(), parts[0]["records"].clone()), (json!("prod"), json!("succeeded"), json!(1)));
    assert!(d["detail"]["window"].is_array(), "the window the run read: {d}");
    let lines: Vec<&str> = d["detail"]["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
    assert!(lines.first().unwrap().starts_with("run.start job=logdelay.measure"), "{lines:?}");
    assert!(lines.last().unwrap().starts_with("run.end status=completed ok=1"), "{lines:?}");

    let g = user(&c, &s, "guest1", "guest").await;
    assert_eq!(c.handle(json!({ "type": "JOB_RUN_DETAIL", "session": &g, "runId": &id })).await["kind"], json!("forbidden"));
    assert_eq!(c.handle(json!({ "type": "JOB_RUN_DETAIL", "session": &u, "runId": "../x" })).await["kind"], json!("bad_request"));
    assert_eq!(c.handle(json!({ "type": "JOB_RUN_DETAIL", "session": &u, "runId": "feedface" })).await["kind"], json!("not_found"));
}

#[tokio::test]
async fn slow_searches_read_tasks_once_label_ours_and_keep_to_the_offered_thresholds() {
    let dir = TempDir::new("slow-searches");
    let srv = cluster().await;
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, Role::All);
    let s = admin(&c).await;
    let res = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "url": srv.url() }] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let a = c.handle(json!({ "type": "SLOW_SEARCHES", "session": &s, "minMs": 30000 })).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    let found: Vec<(String, Value)> = a["searches"].as_array().unwrap().iter()
        .map(|x| (x["taskId"].as_str().unwrap().to_string(), x["by"].clone())).collect();
    assert_eq!(found, vec![("n1:11".to_string(), json!("ElasticPro")), ("n1:12".to_string(), Value::Null)], "{a}");
    assert_eq!(a["searches"][0]["node"], json!("es-data-3"));
    assert_eq!(a["searches"][0]["query"], json!("{\"size\":0}"));
    assert_eq!(a["clustersRead"], json!(1));
    // Within the read interval: from what was read, not asked again.
    let b = c.handle(json!({ "type": "SLOW_SEARCHES", "session": &s, "minMs": 60000 })).await;
    assert_eq!(b["searches"].as_array().unwrap().len(), 1, "{b}");
    let reads = srv.hits().iter().filter(|h| h.path.starts_with("/_tasks")).count();
    assert_eq!(reads, 1, "one read per cluster in the interval");
    assert!(srv.hits().iter().filter(|h| h.path.starts_with("/_tasks")).all(|h| h.method == "GET"), "read only");
    assert_eq!(c.handle(json!({ "type": "SLOW_SEARCHES", "session": &s, "minMs": 5 })).await["kind"], json!("bad_request"));
    assert_eq!(c.handle(json!({ "type": "SLOW_SEARCHES" })).await["kind"], json!("unauthenticated"));
}

#[tokio::test]
async fn two_overlapping_asks_send_one_read_and_a_slow_cluster_does_not_hold_the_answer() {
    let dir = TempDir::new("slow-overlap");
    let srv = cluster_taking(5_500).await;
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, Role::All);
    let s = admin(&c).await;
    let res = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "url": srv.url() }] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let (c1, s1) = (c.clone(), s.clone());
    let first = tokio::spawn(async move { c1.handle(json!({ "type": "SLOW_SEARCHES", "session": &s1 })).await });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let t0 = std::time::Instant::now();
    let second = c.handle(json!({ "type": "SLOW_SEARCHES", "session": &s })).await;
    assert!(t0.elapsed() < std::time::Duration::from_millis(1_500), "the second ask shares the read in flight, it does not wait: {:?}", t0.elapsed());
    assert_eq!(second["reading"][0]["cluster"], json!("prod"), "{second}");
    assert_eq!(second["clustersRead"], json!(0), "being read is not 'none running': {second}");
    let first = first.await.unwrap();
    assert_eq!(first["reading"][0]["cluster"], json!("prod"), "answered within the wait, the read still out: {first}");
    // Once the read is in, the next ask has it, and nothing was read twice.
    tokio::time::sleep(std::time::Duration::from_millis(6_000)).await;
    let third = c.handle(json!({ "type": "SLOW_SEARCHES", "session": &s })).await;
    assert_eq!(third["searches"].as_array().unwrap().len(), 2, "{third}");
    assert_eq!(srv.hits().iter().filter(|h| h.path.starts_with("/_tasks")).count(), 1, "one read per cluster");
}

#[tokio::test]
async fn request_cost_counts_what_was_sent_per_cluster_and_kind_for_an_administrator() {
    let dir = TempDir::new("request-cost");
    let srv = cluster().await;
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, Role::All);
    let s = admin(&c).await;
    let res = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "url": srv.url() }] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(c.handle(json!({ "type": "SLOW_SEARCHES", "session": &s, "minMs": 30000 })).await["ok"], json!(true));
    let cost = c.handle(json!({ "type": "REQUEST_COST", "session": &s })).await;
    assert_eq!(cost["ok"], json!(true), "{cost}");
    let row = cost["rows"].as_array().unwrap().iter().find(|r| r["kind"] == json!("core:slow-searches")).cloned()
        .unwrap_or_else(|| panic!("the _tasks read is counted: {cost}"));
    assert_eq!((row["cluster"].clone(), row["requests"].clone()), (json!("prod"), json!(1)), "{row}");
    assert!(row["avgMs"].is_u64() && row["p95Ms"].is_u64(), "{row}");
    assert!(cost["top"].as_array().unwrap().iter().any(|t| t["path"].as_str().is_some_and(|p| p.starts_with("/_tasks"))), "{cost}");
    let u = user(&c, &s, "user1", "user").await;
    assert_eq!(c.handle(json!({ "type": "REQUEST_COST", "session": &u })).await["kind"], json!("forbidden"), "an administrator's, like REQUEST_LOG");
    assert_eq!(c.handle(json!({ "type": "REQUEST_COST" })).await["kind"], json!("unauthenticated"));
}
