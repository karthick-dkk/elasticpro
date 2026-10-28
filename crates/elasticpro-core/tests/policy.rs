//! The request policy through the message API: modes, the emergency stop, the automatic
//! slow-down, persistence, and who may set it.

mod support;

use elasticpro_core::auth::{authorize, Edition, Role};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{GaugedServer, TempDir, TestServer};

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

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_emergency_stop_holds_everything_tells_the_page_at_once_and_ends_by_itself() {
    let dir = TempDir::new("policy-stop");
    let es = TestServer::start().await;
    // A stop that ends 1.5 s from now, as a core saved it a moment ago.
    let until = now_ms() + 1_500;
    std::fs::write(dir.join("policy.json"), format!(
        r#"{{"mode":"on-demand","paused":{{"all":true,"minutes":15,"since":{},"until":{until},"by":"ann"}}}}"#, now_ms())).unwrap();
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    c.start_fleet_poller();
    // Stopped: the ask is kept, but nobody is held waiting — the page is told at once, by
    // whom, since when and until when.
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert!(t.elapsed() < Duration::from_secs(1), "a stopped ask was held open: {a}");
    assert_eq!((a["ok"].clone(), a["timedOut"].clone()), (json!(true), json!(false)), "{a}");
    assert_eq!(a["paused"]["until"], json!(until), "{a}");
    assert_eq!(a["paused"]["by"], json!("ann"), "{a}");
    assert_eq!(es.connections(), 0, "fetched while stopped");
    // Its end passes: the pending ask runs, and the stop is gone from the file too.
    wait_for("the pending ask to run once the stop ended", || es.connections() > 0).await;
    wait_for("policy.json to lose the stop", || {
        std::fs::read_to_string(dir.join("policy.json")).is_ok_and(|t| !t.contains("\"until\""))
    }).await;
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedAll"], json!(false), "{st}");
}

#[tokio::test]
async fn a_stop_is_stamped_by_the_server_keeps_its_end_and_a_pause_with_no_end_is_dropped() {
    let dir = TempDir::new("policy-stop-stamp");
    let c = portable(&dir);
    let r = set(&c, json!({ "mode": "background" })).await;
    assert!(r["policy"]["paused"].get("since").is_none(), "nothing stopped, nothing stamped: {r}");
    // A new stop: no `since` from the page. The server stamps since and until.
    let r = set(&c, json!({ "paused": { "all": true, "minutes": 30, "since": 0, "until": 1, "by": "somebody else" } })).await;
    let since = r["policy"]["paused"]["since"].as_u64().unwrap();
    let until = r["policy"]["paused"]["until"].as_u64().unwrap();
    assert!(since > 5, "{r}");
    assert_eq!(until, since + 30 * 60_000, "{r}");
    assert!(r["policy"]["paused"].get("by").is_none(), "no caller on the portable build: {r}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!((st["policy"]["pausedSince"].clone(), st["policy"]["pausedUntil"].clone()), (json!(since), json!(until)), "{st}");
    assert_eq!(st["policy"]["pausedAll"], json!(true), "{st}");
    // Another change while it holds keeps when it began and ends: nobody extends it by saving.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let r = set(&c, json!({ "mode": "hybrid", "paused": { "all": true, "minutes": 60, "since": since } })).await;
    assert_eq!((r["policy"]["paused"]["since"].clone(), r["policy"]["paused"]["until"].clone()), (json!(since), json!(until)), "{r}");
    // …and survives a restart.
    drop(c);
    let c = portable(&dir);
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedUntil"], json!(until), "{st}");
    // Lifting it clears the stamp.
    let r = set(&c, json!({ "paused": { "all": false } })).await;
    assert!(r["policy"]["paused"].get("since").is_none(), "{r}");
    // A form still showing the stop that just ended does not begin it again.
    let r = set(&c, json!({ "paused": { "all": true, "minutes": 30, "since": since } })).await;
    assert_eq!(r["policy"]["paused"]["all"], json!(false), "a stop that ended was begun again: {r}");
    drop(c);
    // What 0.3.43 left behind — paused for everyone with no end, and one cluster paused —
    // is dropped when the next core reads it.
    std::fs::write(dir.join("policy.json"), r#"{"mode":"hybrid","paused":{"all":true,"clusters":["c1"],"since":5,"by":"Admin"}}"#).unwrap();
    let c = portable(&dir);
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedAll"], json!(false), "{st}");
    assert_eq!(st["policy"]["mode"], json!("hybrid"), "the rest of the file is kept: {st}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nobody_waits_more_than_10_s_and_a_slow_cluster_is_slowed_without_anybody_deciding() {
    assert_eq!(elasticpro_core::fleet::MAX_WAIT, Duration::from_secs(10));
    let dir = TempDir::new("policy-slow");
    // Cluster health takes 11 s: past the 10 s a page waits, and past the 8 s that counts as slow.
    let es = GaugedServer::start(|h| (200, r#"{"cluster_name":"slow","status":"green","number_of_nodes":1}"#.to_string(),
        if h.path.starts_with("/_cluster/health") { 11_000 } else { 0 })).await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    set(&c, json!({ "mode": "on-demand" })).await;
    c.start_fleet_poller();
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    let held = t.elapsed();
    assert!(held >= Duration::from_millis(9_500) && held < Duration::from_millis(10_800), "held {held:?}: {a}");
    assert_eq!(a["timedOut"], json!(true), "{a}");
    // The answer arrives a second later; the cluster is marked slowed, said everywhere.
    let deadline = Instant::now() + Duration::from_secs(8);
    let st = loop {
        let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
        if st["automation"]["slowed"]["c1"].is_object() || Instant::now() > deadline { break st; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let s = &st["automation"]["slowed"]["c1"];
    assert!(s["reason"].as_str().unwrap_or("").contains("over 8 s"), "{st}");
    assert_eq!(st["clusters"]["c1"]["slowed"]["level"], json!(1), "{st}");
    let log = c.handle(json!({ "type": "REQUEST_LOG" })).await;
    assert!(log["slowed"]["c1"].is_object(), "the Request Centre is not told: {}", log["slowed"]);
    // Slowed, with a copy held: the page gets it at once rather than waiting again.
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true, "maxAgeSec": 0 })).await;
    assert!(t.elapsed() < Duration::from_secs(1), "a slowed cluster's held copy was not given at once: {a}");
    assert_eq!(a["entry"]["status"], json!("ok"), "{a}");
    assert!(a["slowed"]["since"].as_u64().is_some(), "{a}");
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
