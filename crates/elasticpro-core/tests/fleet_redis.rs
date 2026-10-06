//! The hosted build's Redis write-through, with Redis not there. The cache is a copy;
//! losing the copy must never cost an answer.

#![cfg(feature = "bridge")]

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::json;
use std::time::{Duration, Instant};
use support::{TempDir, TestServer};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redis_that_is_down_costs_nothing() {
    let port = support::dead_port().await;
    // Its own test binary, so setting this cannot leak into another test.
    std::env::set_var("ELASTICPRO_REDIS_URL", format!("redis://127.0.0.1:{port}/"));
    let dir = TempDir::new("fleet-redis-down");
    let es = TestServer::start().await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "c1", "url": es.url() }] })).await;
    assert_eq!(r["ok"], json!(true));
    c.start_fleet_poller();

    let t = Instant::now();
    for _ in 0..3 {
        let r = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true, "maxAgeSec": 0 })).await;
        assert_eq!(r["entry"]["status"], json!("ok"), "{r}");
    }
    assert!(t.elapsed() < Duration::from_secs(2), "Redis being down slowed the cache: {:?}", t.elapsed());
    // The disk copy is still written.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !dir.join("cache/c1/health.json").exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
