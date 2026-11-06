//! The running-snapshot reading through the message API: the `snapshot_status` dataset is
//! one small cluster-wide request; `SNAPSHOT_RUNNING` reads the cache and never fetches;
//! under Client basis it says "unknown" until the Snapshots page asks, and under Background
//! it knows for every cluster.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{TempDir, TestServer};

const STATUS: &str = r#"{"snapshots":[
  {"snapshot":"daily-2026.11.05","repository":"backups","state":"STARTED","shards_stats":{"done":3,"total":10},
   "stats":{"start_time_in_millis":1762300000000,"time_in_millis":120000}},
  {"snapshot":"done","repository":"backups","state":"SUCCESS","stats":{"start_time_in_millis":1762200000000}}
]}"#;

async fn cluster() -> TestServer {
    TestServer::with(|h| {
        let p = h.path.as_str();
        if p.starts_with("/_snapshot/_status") {
            return (200, STATUS.into());
        }
        if p.starts_with("/_snapshot?") {
            return (200, r#"{"backups":{"type":"fs"}}"#.into());
        }
        if p.starts_with("/_cat/snapshots/") {
            return (200, "[]".into());
        }
        (200, r#"{"cluster_name":"test","status":"green"}"#.into())
    })
    .await
}

fn portable(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1)
}

async fn wait_known(c: &Arc<Core>, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let r = c.handle(json!({ "type": "SNAPSHOT_RUNNING" })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
        if r["clusters"][id]["known"] == json!(true) {
            return r;
        }
        assert!(Instant::now() < deadline, "the reading never arrived: {r}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn under_background_every_cluster_is_known_and_the_request_is_one_filtered_status() {
    let dir = TempDir::new("snaprun-bg");
    let es = cluster().await;
    let c = portable(&dir);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "c1", "url": es.url() }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = c.handle(json!({ "type": "POLICY_SET", "policy": { "mode": "background" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c.start_fleet_poller();

    let r = wait_known(&c, "c1").await;
    assert_eq!(r["effectiveClass"], json!("background"));
    assert_eq!(r["intervalSec"], json!(300));
    assert_eq!(r["unknown"], json!([]));
    let cl = &r["clusters"]["c1"];
    assert_eq!(cl["why"], Value::Null);
    assert_eq!(cl["running"].as_array().unwrap().len(), 1, "the finished one is not running: {cl}");
    assert_eq!(cl["running"][0]["snapshot"], json!("daily-2026.11.05"));
    assert_eq!(cl["running"][0]["repository"], json!("backups"));
    assert_eq!(cl["running"][0]["started"], json!(1762300000000u64));
    assert_eq!(cl["running"][0]["shards"]["done"], json!(3));
    assert_eq!(r["running"][0]["cluster"], json!("c1"));
    assert_eq!(r["running"].as_array().unwrap().len(), 1);

    // One request, cluster-wide, with the filter: never per repository, never the full detail.
    let status_hits: Vec<String> = es.hits().into_iter().map(|h| h.path).filter(|p| p.starts_with("/_snapshot/_status")).collect();
    assert!(!status_hits.is_empty());
    assert!(status_hits.iter().all(|p| p.contains("filter_path=snapshots.snapshot")), "{status_hits:?}");

    // The dataset is in the default FLEET_STATE set, under its own name.
    let s = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(s["clusters"]["c1"]["datasets"]["snapshot_status"]["status"], json!("ok"));
    assert_eq!(s["clusters"]["c1"]["datasets"]["snapshot_status"]["data"]["status"]["json"]["snapshots"][0]["state"], json!("STARTED"));

    // Naming one cluster narrows; naming an unknown one is a refusal, not an empty answer.
    let one = c.handle(json!({ "type": "SNAPSHOT_RUNNING", "clusterId": "c1" })).await;
    assert_eq!(one["clusters"].as_object().unwrap().len(), 1);
    assert_eq!(c.handle(json!({ "type": "SNAPSHOT_RUNNING", "clusterId": "nope" })).await["kind"], json!("not_found"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn under_client_basis_nothing_is_fetched_and_the_answer_says_unknown_until_a_page_asks() {
    let dir = TempDir::new("snaprun-cb");
    let es = cluster().await;
    let c = portable(&dir);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "c1", "url": es.url() }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c.start_fleet_poller();
    tokio::time::sleep(Duration::from_millis(600)).await;

    // Nothing asked: nothing sent, and the reading is unknown — with a reason, never "none running".
    let r = c.handle(json!({ "type": "SNAPSHOT_RUNNING" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["effectiveClass"], json!("onDemand"));
    assert_eq!(r["unknown"], json!(["c1"]));
    assert_eq!(r["clusters"]["c1"]["known"], json!(false));
    assert_eq!(r["clusters"]["c1"]["why"], json!("not fetched yet"));
    assert_eq!(r["clusters"]["c1"]["running"], json!([]));
    assert_eq!(r["running"], json!([]));
    assert!(es.hits().iter().all(|h| !h.path.starts_with("/_snapshot/_status")), "SNAPSHOT_RUNNING must never fetch");

    // A plain refresh (the button, `r`, Retry, a trust action: REFRESH with no datasets) asks
    // for the background set, which under Client basis leaves snapshot_status out: only the
    // Snapshots page names it. The other background datasets are requested.
    let r = c.handle(json!({ "type": "REFRESH", "clusterIds": ["c1"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while es.hits().iter().all(|h| !h.path.starts_with("/_cluster/health")) {
        assert!(Instant::now() < deadline, "the refresh never reached the cluster");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(es.hits().iter().all(|h| !h.path.starts_with("/_snapshot/_status")),
            "a plain refresh under Client basis must not fetch snapshot_status: {:?}",
            es.hits().iter().map(|h| h.path.clone()).collect::<Vec<_>>());
    assert!(c.fleet_pending("c1").iter().all(|d| d != "snapshot_status"));
    let r = c.handle(json!({ "type": "SNAPSHOT_RUNNING" })).await;
    assert_eq!(r["clusters"]["c1"]["why"], json!("not fetched yet"));

    // The Snapshots page asks for the dataset (state.js moduleDatasets): then it is known.
    let d = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "snapshot_status", "wait": true })).await;
    assert_eq!(d["ok"], json!(true), "{d}");
    let r = wait_known(&c, "c1").await;
    assert_eq!(r["running"][0]["snapshot"], json!("daily-2026.11.05"));
}
