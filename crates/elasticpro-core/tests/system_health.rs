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
    // No Database part: ElasticPro does not use the db container (0.3.77).
    assert_eq!(parts, ["core", "worker", "redis", "zabbix", "mail", "history"]);
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
    // The reports share of memory.rs: its budget, and what it holds not known rather than zero.
    let rep = &r["core"]["budget"]["reports"];
    assert!(rep["budgetBytes"].as_u64().is_some_and(|b| b >= 64 * 1024 * 1024), "{rep}");
    assert!(rep["usedBytes"].is_null(), "{rep}");
    assert_eq!(rep["holder"], json!("this process"), "role all runs the reports itself: {rep}");
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

/// HEALTH_HISTORY (docs/HEALTH.md "History", 0.3.77): the Jobs page's health lines, kept 7 days on
/// the server. A user reads the strip's figures; the ElasticPro health figures are an
/// administrator's; a caller limited to some clusters does not read the fleet-wide counts.
#[tokio::test]
async fn health_history_is_kept_and_narrowed_by_who_reads() {
    let dir = TempDir::new("health-history");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    for _ in 0..10 {
        c.health_sample().await;
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    assert!(dir.0.join("health").join("history-all.json").exists(), "the week's history is not written to the data directory");

    let admin = c.handle_as(json!({ "type": "HEALTH_HISTORY", "range": "24h" }), Some(who(Role::Admin))).await;
    assert_eq!(admin["ok"], json!(true), "{admin}");
    assert_eq!(admin["stepMs"], json!(60_000));
    let fields: Vec<&str> = admin["fields"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
    assert_eq!(fields[0], "t");
    for f in ["coreCpu", "workerCpu", "rps", "busy", "coreRss", "p95Ms", "refused", "latePct", "diskFreePct"] {
        assert!(fields.contains(&f), "an administrator does not read {f}: {fields:?}");
    }
    let points = admin["points"].as_array().unwrap();
    assert!(!points.is_empty() && points.len() <= 10, "{}", points.len());
    assert!(points.iter().all(|p| p.as_array().unwrap().len() == fields.len()));
    // Role all: no worker, so its CPU is not known (null), never 0.
    let wi = fields.iter().position(|f| *f == "workerCpu").unwrap();
    assert!(points.iter().all(|p| p[wi].is_null()), "a worker that is not deployed has a CPU figure");

    let user = c.handle_as(json!({ "type": "HEALTH_HISTORY", "range": "1h" }), Some(who(Role::User))).await;
    assert_eq!(user["ok"], json!(true), "{user}");
    let uf: Vec<&str> = user["fields"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
    assert!(uf.contains(&"coreCpu") && uf.contains(&"rps") && !uf.contains(&"p95Ms") && !uf.contains(&"diskFreePct"), "{uf:?}");

    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["ES one".into()]), play: None };
    let l = c.handle_as(json!({ "type": "HEALTH_HISTORY", "range": "7d" }), Some(limited)).await;
    assert_eq!(l["ok"], json!(true), "{l}");
    assert_eq!(l["stepMs"], json!(600_000));
    assert_eq!(l["limited"], json!(true));
    let lf: Vec<&str> = l["fields"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
    assert!(!lf.contains(&"rps") && !lf.contains(&"busy"), "a limited caller reads the fleet-wide counts: {lf:?}");

    let bad = c.handle_as(json!({ "type": "HEALTH_HISTORY", "range": "2h" }), Some(who(Role::Admin))).await;
    assert_eq!(bad["kind"], json!("bad_request"));
    let guest = c.handle_as(json!({ "type": "HEALTH_HISTORY" }), Some(who(Role::Guest))).await;
    assert_eq!(guest["ok"], json!(false), "a guest reads the health history: {guest}");

    // A restart keeps the week (the file is read back).
    drop(c);
    let again = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let r = again.handle_as(json!({ "type": "HEALTH_HISTORY", "range": "24h" }), Some(who(Role::Admin))).await;
    assert!(!r["points"].as_array().unwrap().is_empty(), "the history did not survive a restart: {r}");
}
