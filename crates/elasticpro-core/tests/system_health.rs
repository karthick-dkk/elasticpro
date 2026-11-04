//! SYSTEM_HEALTH (docs/HEALTH.md): an administrator's read of ElasticPro's own health, that
//! never sends a cluster anything; PING carries the level for the Request Centre's nav dot.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role, DEFAULT_PASSWORD, DEFAULT_USER};
use elasticpro_core::Core;
use serde_json::json;
use support::{TempDir, TestServer};

fn who(role: Role) -> Caller {
    Caller { name: format!("{}-1", role.as_str()), role, must_change: false, scope: None, play: None }
}

#[tokio::test]
async fn an_admin_reads_the_snapshot_and_no_cluster_is_asked() {
    let dir = TempDir::new("sys-health");
    let a = TestServer::start().await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = c.handle(json!({ "type": "LOGIN", "name": DEFAULT_USER, "password": DEFAULT_PASSWORD })).await["session"]
        .as_str().expect("a session").to_string();
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [{ "id": "w", "url": a.url(), "authHeader": "" }] })).await;
    for _ in 0..5 {
        c.handle(json!({ "type": "PING", "session": s })).await;
    }
    let before = a.hits().len();

    let r = c.handle_as(json!({ "type": "SYSTEM_HEALTH" }), Some(who(Role::Admin))).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(a.hits().len(), before, "opening the tab sent a cluster something");
    assert_eq!(r["role"], json!("all"));
    assert_eq!(r["worker"]["state"], json!("not_deployed"), "{}", r["worker"]);
    assert!(r["worker"]["text"].as_str().unwrap().starts_with("not deployed — role all"));
    let parts: Vec<&str> = r["parts"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(parts, ["core", "worker", "redis", "database", "zabbix", "mail", "history"]);
    assert_eq!(r["parts"][3]["level"], json!("unknown"), "the database cannot report and says so, never green");
    let ids: Vec<&str> = r["checks"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    for want in ["core.memory", "core.cpu", "messages.p95", "gate.refused", "poller.late", "worker.heartbeat", "disk.free"] {
        assert!(ids.contains(&want), "no {want} in {ids:?}");
    }
    assert!(!ids.contains(&"worker.memory"), "no worker, no worker memory line");
    assert_eq!(r["thresholds"].as_array().unwrap().len(), 7);
    let pings = r["core"]["messages"]["w5m"]["byType"].as_array().unwrap().iter().find(|t| t["type"] == json!("PING")).cloned();
    assert!(pings.is_some_and(|p| p["count"].as_u64().unwrap() >= 5), "{}", r["core"]["messages"]);
    let classes: Vec<&str> = r["core"]["gate"]["classes"].as_array().unwrap().iter().map(|c| c["class"].as_str().unwrap()).collect();
    assert_eq!(classes, ["interactive", "prompted", "background"]);
    assert!(r["core"]["budget"]["reports"].is_null(), "no reports share in memory.rs yet: not known, not zero");
    assert!(r["core"]["disk"]["areas"].as_array().is_some_and(|a| a.len() == 5), "{}", r["core"]["disk"]);
    assert_eq!(r["trends"]["points"].as_array().map(|p| p.len()), Some(1), "the first read takes the first sample");

    // PING carries the level for an administrator, and not for anybody else.
    let p = c.handle_as(json!({ "type": "PING" }), Some(who(Role::Admin))).await;
    assert!(matches!(p["health"].as_str(), Some("ok" | "warn" | "bad")), "{}", p["health"]);
    let p = c.handle_as(json!({ "type": "PING" }), Some(who(Role::Operator))).await;
    assert!(p.get("health").is_none(), "an operator's PING carries the health level: {p}");
}

#[tokio::test]
async fn nobody_below_admin_reads_it() {
    let dir = TempDir::new("sys-health-roles");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    for role in [Role::Operator, Role::User, Role::Guest] {
        let r = c.handle_as(json!({ "type": "SYSTEM_HEALTH" }), Some(who(role))).await;
        assert_eq!((r["ok"].clone(), r["kind"].clone()), (json!(false), json!("forbidden")), "{role:?}: {r}");
    }
    let r = c.handle(json!({ "type": "SYSTEM_HEALTH" })).await;
    assert_eq!(r["kind"], json!("unauthenticated"), "{r}");
}
