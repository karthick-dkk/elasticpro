//! The request policy through the message API: modes, pause, persistence, and who may set it.

mod support;

use elasticpro_core::auth::{authorize, Edition, Role};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{TempDir, TestServer};

fn portable(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1)
}

async fn prime(c: &Arc<Core>, url: &str, id: &str) {
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": id, "url": url }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

async fn set(c: &Arc<Core>, policy: Value) -> Value {
    let r = c.handle(json!({ "type": "POLICY_SET", "policy": policy })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    r
}

async fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn on_demand_a_fresh_core_sends_nothing_until_a_page_asks_and_then_only_that() {
    let dir = TempDir::new("policy-on-demand");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    let r = set(&c, json!({ "mode": "on-demand", "concurrency": { "perCluster": 1 } })).await;
    assert_eq!(r["policy"]["mode"], json!("on-demand"));
    assert_eq!(r["effective"]["health"], json!("onDemand"), "{r}");
    assert_eq!(r["saved"], json!(true));
    c.start_fleet_poller();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(es.connections(), 0, "the poller went to the cluster on its own: {:?}", es.hits());

    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert_eq!(a["entry"]["status"], json!("ok"), "{a}");
    let paths: Vec<String> = es.hits().into_iter().map(|h| h.path).collect();
    assert!(!paths.is_empty());
    assert!(paths.iter().all(|p| p == "/" || p.starts_with("/_cluster/health")), "only what was asked for: {paths:?}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["mode"], json!("on-demand"), "{st}");
    let cat = st["catalogue"].as_array().unwrap();
    assert!(cat.iter().all(|d| d["effectiveClass"] == json!("onDemand")), "{cat:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paused_cluster_is_left_alone_and_the_ask_runs_when_the_pause_lifts() {
    let dir = TempDir::new("policy-pause");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    set(&c, json!({ "paused": { "clusters": ["c1"] } })).await;
    c.start_fleet_poller();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(es.connections(), 0, "a paused cluster was fetched");
    // Paused: the ask is kept, but nobody is held waiting for it — the page is told at once
    // that the cluster is paused, since when and by whom, instead of "Fetching…" for days.
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert!(t.elapsed() < Duration::from_secs(2), "a paused ask was held open: {a}");
    assert_eq!(a["ok"], json!(true), "{a}");
    assert_eq!(a["timedOut"], json!(false), "{a}");
    assert_eq!(a["paused"]["all"], json!(false), "{a}");
    assert!(a["paused"]["since"].as_u64().unwrap_or(0) > 0, "since when: {a}");
    assert_eq!(es.connections(), 0);
    set(&c, json!({ "paused": { "clusters": [] } })).await;
    wait_for("the pending ask to run once unpaused", || es.connections() > 0).await;
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert!(a.get("paused").is_none(), "no longer paused: {a}");
}

#[tokio::test]
async fn a_pause_says_since_when_and_keeps_that_while_it_lasts() {
    let dir = TempDir::new("policy-pause-stamp");
    let c = portable(&dir);
    let r = set(&c, json!({ "mode": "background" })).await;
    assert!(r["policy"]["paused"].get("since").is_none(), "nothing paused, nothing stamped: {r}");
    // What a page sends is ignored: the server stamps it.
    let r = set(&c, json!({ "paused": { "all": true, "since": 5, "by": "somebody else" } })).await;
    let since = r["policy"]["paused"]["since"].as_u64().unwrap();
    assert!(since > 5, "{r}");
    assert!(r["policy"]["paused"].get("by").is_none(), "no caller on the portable build: {r}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedSince"], json!(since), "{st}");
    // Another change while the same pause holds keeps when it began…
    tokio::time::sleep(Duration::from_millis(20)).await;
    let r = set(&c, json!({ "mode": "hybrid", "paused": { "all": true, "since": 0 } })).await;
    assert_eq!(r["policy"]["paused"]["since"], json!(since), "{r}");
    // …and survives a restart.
    drop(c);
    let c = portable(&dir);
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedSince"], json!(since), "{st}");
    // Lifting it clears the stamp.
    let r = set(&c, json!({ "paused": { "all": false } })).await;
    assert!(r["policy"]["paused"].get("since").is_none(), "{r}");
}

#[tokio::test]
async fn the_policy_is_written_0600_and_read_back_by_the_next_core() {
    let dir = TempDir::new("policy-persist");
    {
        let c = portable(&dir);
        let r = set(&c, json!({ "mode": "hybrid", "intervalsSec": { "nodes": 90, "health": 5 }, "watchMinutes": 500 })).await;
        assert_eq!(r["policy"]["intervalsSec"]["nodes"], json!(90));
        assert_eq!(r["policy"]["intervalsSec"]["health"], json!(60), "bounded, not refused");
        assert_eq!(r["policy"]["watchMinutes"], json!(240));
        assert_eq!(r["stored"], json!(true));
    }
    let path = dir.join("policy.json");
    assert!(path.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let c = portable(&dir);
    let g = c.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["ok"], json!(true));
    assert_eq!(g["policy"]["mode"], json!("hybrid"));
    assert_eq!(g["effective"]["health"], json!("background"));
    assert_eq!(g["effective"]["nodes"], json!("onDemand"));
    assert_eq!(g["defaults"]["mode"], json!("on-demand"));
}

#[tokio::test]
async fn a_policy_that_does_not_parse_is_refused_and_nothing_changes() {
    let dir = TempDir::new("policy-bad");
    let c = portable(&dir);
    for bad in [json!({ "mode": "sometimes" }), json!("on-demand"), json!({ "concurrency": "lots" })] {
        let r = c.handle(json!({ "type": "POLICY_SET", "policy": bad })).await;
        assert_eq!(r["ok"], json!(false), "{r}");
        assert_eq!(r["kind"], json!("bad_request"));
    }
    let g = c.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["policy"]["mode"], json!("on-demand"));
    assert_eq!(g["stored"], json!(false));
}

#[tokio::test]
async fn a_fresh_install_runs_client_basis_and_reports_it_as_the_defaults() {
    let dir = TempDir::new("policy-client-basis");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    let g = c.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["policy"]["mode"], json!("on-demand"), "{g}");
    assert_eq!(g["resolvedMode"], json!("on-demand"), "{g}");
    assert_eq!(g["stored"], json!(false));
    assert_eq!(g["policy"]["concurrency"]["perCluster"], json!(1));
    assert_eq!(g["policy"]["concurrency"]["global"], json!(4));
    assert_eq!(g["policy"], g["defaults"], "no file: the policy running is the shipped one");
    // Reported either way, so the page can tell "not set" from an older core that does not say.
    assert!(g.get("pollConcurrencyEnv").is_some(), "{g}");
    if std::env::var("ELASTICPRO_POLL_CONCURRENCY").is_err() {
        assert_eq!(g["pollConcurrencyEnv"], Value::Null, "{g}");
    }
    assert!(g["effective"].as_object().unwrap().values().all(|v| v == "onDemand"), "{g}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["mode"], json!("on-demand"), "{st}");
    assert_eq!(st["policy"]["resolvedMode"], json!("on-demand"), "{st}");
}

#[tokio::test]
async fn a_policy_somebody_saved_is_not_rewritten_and_auto_still_resolves_by_fleet_size() {
    let dir = TempDir::new("policy-saved-auto");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    let r = set(&c, json!({ "mode": "auto" })).await;
    assert_eq!(r["policy"]["mode"], json!("auto"), "{r}");
    assert_eq!(r["resolvedMode"], json!("background"), "{r}");
    assert_eq!(r["effective"]["nodes"], json!("background"));
    // A file that leaves concurrency out keeps the classic numbers it always had.
    assert_eq!(r["policy"]["concurrency"]["perCluster"], json!(2), "{r}");
    let before = std::fs::read(dir.join("policy.json")).unwrap();
    drop(c);
    let c2 = portable(&dir);
    let g = c2.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["policy"]["mode"], json!("auto"), "{g}");
    assert_eq!(g["defaults"]["mode"], json!("on-demand"));
    assert_eq!(std::fs::read(dir.join("policy.json")).unwrap(), before, "reading never rewrites the file");
}

#[test]
fn reading_the_policy_takes_a_user_and_changing_it_an_administrator() {
    assert!(authorize(Role::User, "POLICY_GET", "", "").is_ok());
    assert!(authorize(Role::Guest, "POLICY_GET", "", "").is_err());
    assert!(authorize(Role::Operator, "POLICY_SET", "", "").is_err());
    assert!(authorize(Role::Admin, "POLICY_SET", "", "").is_ok());
}
