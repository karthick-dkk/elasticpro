//! The start-up restore keeps to the cache budget. 0.3.21 read every file of the disk
//! cache back whatever the budget, and a large fleet's cache did not fit its container.
//!
//! Its own test binary: the budget is read from ELASTICPRO_CACHE_MB once per process.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::fleet::catalogue::Dataset;
use elasticpro_core::fleet::entry::{Body, Entry, Status};
use elasticpro_core::fleet::store::DiskStore;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

fn entry(data: Value, fetched_at: u64) -> Entry {
    let mut e = Entry::never(1, None);
    e.status = Status::Ok;
    e.fetched_at = Some(fetched_at);
    e.data = Some(Body::from_value(&data));
    e
}

#[tokio::test]
async fn the_disk_restore_keeps_to_the_budget_health_first_then_newest_first() {
    std::env::set_var("ELASTICPRO_CACHE_MB", "1");
    let dir = TempDir::new("fleet-budget");
    let disk = DiskStore::new(Some(&dir.0));
    // Four clusters: a little health each, and an index list of ~300 KB each, c3's newest.
    // A 1 MiB budget holds every health and three of the four lists.
    for i in 0..4u64 {
        let c = format!("c{i}");
        disk.save(&c, Dataset::Health, &entry(json!({ "health": { "ok": true, "json": { "status": "green" } } }), 1_000 + i), 0);
        disk.save(&c, Dataset::Indices, &entry(json!({ "indices": { "ok": true, "json": "i".repeat(300_000) } }), 2_000 + i), 0);
    }
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let clusters: Vec<Value> = (0..4).map(|i| json!({ "id": format!("c{i}"), "url": "http://127.0.0.1:9" })).collect();
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": clusters })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c.start_fleet_poller();
    // One thread: nothing the poller spawned has run yet.
    let s = c.handle(json!({ "type": "FLEET_STATE", "include": ["health", "indices"] })).await;
    for i in 0..4 {
        let h = &s["clusters"][format!("c{i}")]["datasets"]["health"];
        assert_eq!(h["status"], json!("restored"), "every health comes back: {h}");
    }
    let restored: Vec<String> = (0..4)
        .filter(|i| s["clusters"][format!("c{i}")]["datasets"].get("indices").is_some())
        .map(|i| format!("c{i}"))
        .collect();
    assert_eq!(restored, vec!["c1", "c2", "c3"], "the newest three lists fit, the oldest is left on disk");
    assert_eq!(s["clusters"]["c3"]["datasets"]["indices"]["data"]["indices"]["json"].as_str().map(str::len), Some(300_000));
    // Left on disk, not deleted: a bigger budget next time brings it back.
    assert!(dir.join("cache/c0/indices.json.gz").exists());
}
