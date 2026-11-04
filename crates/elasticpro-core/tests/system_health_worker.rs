//! The worker as SYSTEM_HEALTH shows it in role `core` (docs/HEALTH.md, docs/WORKER.md): no
//! status file is red, a fresh heartbeat is up, a stale one or another version is red; and the
//! day's samples survive a restart. One test, alone in its binary: it sets ELASTICPRO_ROLE.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::health::{MemoryFigures, WorkerStatus, WORKER_STATUS_SCHEMA};
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

fn admin() -> Option<Caller> {
    Some(Caller { name: "admin".into(), role: Role::Admin, must_change: false, scope: None, play: None })
}

fn check<'a>(r: &'a Value, id: &str) -> &'a Value {
    r["checks"].as_array().unwrap().iter().find(|c| c["id"] == json!(id)).unwrap_or_else(|| panic!("no {id}: {}", r["checks"]))
}

#[tokio::test]
async fn role_core_reads_the_workers_status_file() {
    std::env::set_var("ELASTICPRO_ROLE", "core");
    let dir = TempDir::new("sys-health-worker");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);

    let r = c.handle_as(json!({ "type": "SYSTEM_HEALTH" }), admin()).await;
    assert_eq!(r["role"], json!("core"), "{r}");
    assert_eq!(r["worker"]["state"], json!("missing"));
    assert_eq!(check(&r, "worker.heartbeat")["level"], json!("bad"));
    assert!(check(&r, "worker.heartbeat")["fix"].as_str().unwrap().contains("docker compose"));
    assert_eq!(r["level"], json!("bad"));

    let now = elasticpro_core::fleet::now_ms();
    let mut st = WorkerStatus {
        schema: WORKER_STATUS_SCHEMA, role: "worker".into(), version: elasticpro_core::VERSION.into(),
        started_at: now - 60_000, heartbeat_at: now - 2_000,
        memory: MemoryFigures { rss_bytes: Some(950), limit_bytes: Some(1000), used_pct: Some(95.0), ..Default::default() },
        ..Default::default()
    };
    st.write(&dir.0).unwrap();
    let r = c.handle_as(json!({ "type": "SYSTEM_HEALTH" }), admin()).await;
    assert_eq!(r["worker"]["state"], json!("up"), "{}", r["worker"]);
    assert_eq!(check(&r, "worker.heartbeat")["level"], json!("ok"));
    assert_eq!(check(&r, "worker.memory")["level"], json!("bad"), "the worker's own memory is checked once it reports");
    assert_eq!(r["parts"][1]["level"], json!("ok"));

    st.heartbeat_at = now - 120_000;
    st.write(&dir.0).unwrap();
    let r = c.handle_as(json!({ "type": "SYSTEM_HEALTH" }), admin()).await;
    assert_eq!((r["worker"]["state"].clone(), check(&r, "worker.heartbeat")["level"].clone()), (json!("down"), json!("bad")));

    st.heartbeat_at = now;
    st.version = "0.0.1".into();
    st.write(&dir.0).unwrap();
    let r = c.handle_as(json!({ "type": "SYSTEM_HEALTH" }), admin()).await;
    assert_eq!(r["worker"]["state"], json!("version"));
    assert!(check(&r, "worker.heartbeat")["fix"].as_str().unwrap().contains("same image"));

    // Ten samples write the day to <data>/health/core.json; a new core starts from it.
    for _ in 0..10 {
        c.health_sample().await;
    }
    assert!(dir.0.join("health/core.json").exists());
    drop(c);
    let c2 = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let r = c2.handle_as(json!({ "type": "SYSTEM_HEALTH" }), admin()).await;
    let n = r["trends"]["points"].as_array().unwrap().len();
    assert!(n >= 11, "the restart kept the day: {n} points");
    std::env::remove_var("ELASTICPRO_ROLE");
}
