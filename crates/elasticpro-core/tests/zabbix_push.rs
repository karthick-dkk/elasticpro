//! The request figures pushed to Zabbix (zbx_push.rs), against a mock Zabbix API: off
//! unless a host is named, nothing called while the API is not configured, `history.push`
//! with the right shape when it is, and failures counted and backed off.
//!
//! The host, the token file and the interval are given to `start_zabbix_push_with` and the API through
//! `new_with_server_zbx`, so no test touches the process environment.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_link::ServerZbx;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use support::{TempDir, TestServer};

const TOKEN: &str = "push-token-0123456789abcdef";
const PASSWORD: &str = "correct-horse-battery";
const EVERY: Duration = Duration::from_millis(60);

/// A Zabbix API that takes `history.push` (or refuses every value while `refuse` is set)
/// and nothing else.
async fn mock_zabbix(refuse: Arc<AtomicBool>) -> TestServer {
    mock_zabbix_for(TOKEN, refuse).await
}

async fn mock_zabbix_for(token: &'static str, refuse: Arc<AtomicBool>) -> TestServer {
    TestServer::with(move |hit| {
        let req: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
        assert_eq!(hit.header("authorization"), Some(format!("Bearer {token}").as_str()), "the right token must be sent");
        assert_eq!(req["method"], json!("history.push"), "the push calls history.push and nothing else");
        let data = if refuse.load(Ordering::SeqCst) {
            json!([{ "error": "No permissions to referred object or it does not exist." }])
        } else {
            json!([{ "itemid": "45001" }])
        };
        (200, json!({ "jsonrpc": "2.0", "id": 1, "result": { "response": "success", "data": data } }).to_string())
    }).await
}

fn core(dir: &TempDir, api: Option<String>, token: Option<&str>) -> Arc<Core> {
    let server = ServerZbx { api_url: api, api_token: token.map(String::from), ..Default::default() };
    Core::new_with_server_zbx(Some(dir.0.clone()), Edition::Hosted, 1, server)
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn push_status(c: &Arc<Core>, s: &str) -> Value {
    let log = c.handle(json!({ "type": "REQUEST_LOG", "session": s })).await;
    assert_eq!(log["ok"], json!(true), "{log}");
    log["gate"]["zabbixPush"].clone()
}

/// Wait (bounded) until the mock has seen `n` calls.
async fn calls(z: &TestServer, n: usize) -> Vec<support::Hit> {
    for _ in 0..100 {
        let hits = z.hits();
        if hits.len() >= n {
            return hits;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the mock Zabbix saw {} calls, wanted {n}", z.hits().len());
}

#[tokio::test]
async fn no_host_means_no_calls_at_all() {
    let z = mock_zabbix(Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("zpush-off");
    let c = core(&dir, Some(format!("{}/api_jsonrpc.php", z.url())), Some(TOKEN));
    c.start_zabbix_push_with(None, None, EVERY);
    tokio::time::sleep(EVERY * 6).await;
    assert_eq!(z.hits().len(), 0, "ZABBIX_METRICS_HOST unset: the Zabbix API is configured, and still nothing is sent");
    let s = admin(&c).await;
    let st = push_status(&c, &s).await;
    assert_eq!(st["enabled"], json!(false), "{st}");
    assert_eq!(st["idle"], json!("ZABBIX_METRICS_HOST is not set"));
    assert_eq!(st["pushes"], json!(0));
}

#[tokio::test]
async fn a_host_without_a_configured_api_calls_nothing() {
    let z = mock_zabbix(Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("zpush-noapi");
    // The address is there, the token is not: not configured.
    let c = core(&dir, Some(format!("{}/api_jsonrpc.php", z.url())), None);
    c.start_zabbix_push_with(Some("ElasticPro".into()), None, EVERY);
    tokio::time::sleep(EVERY * 6).await;
    assert_eq!(z.hits().len(), 0, "no token: no call");
    let s = admin(&c).await;
    let st = push_status(&c, &s).await;
    assert_eq!(st["enabled"], json!(true));
    assert!(st["idle"].as_str().unwrap_or("").contains("not configured"), "{st}");
    // A name Zabbix would refuse is refused here, before anything is sent.
    let dir2 = TempDir::new("zpush-badname");
    let c2 = core(&dir2, Some(format!("{}/api_jsonrpc.php", z.url())), Some(TOKEN));
    c2.start_zabbix_push_with(Some("https://zabbix/".into()), None, EVERY);
    tokio::time::sleep(EVERY * 4).await;
    assert_eq!(z.hits().len(), 0, "an invalid host name: no call");
}

/// The normal path: the paired (link) token, no override file.
#[tokio::test]
async fn the_figures_go_to_the_trapper_item_by_history_push() {
    let z = mock_zabbix(Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("zpush-on");
    let c = core(&dir, Some(format!("{}/api_jsonrpc.php", z.url())), Some(TOKEN));
    c.start_zabbix_push_with(Some("ElasticPro".into()), None, EVERY);
    let hits = calls(&z, 2).await;
    let req: Value = serde_json::from_str(&hits[0].body).unwrap();
    assert_eq!(req["jsonrpc"], json!("2.0"));
    let params = req["params"].as_array().expect("history.push takes an array of values");
    assert_eq!(params.len(), 1, "one master value per push: {req}");
    let p = &params[0];
    assert_eq!(p["host"], json!("ElasticPro"));
    assert_eq!(p["key"], json!("elasticpro.gate.raw"));
    assert!(p["clock"].as_u64().is_some_and(|c| c > 1_700_000_000), "{p}");
    // The value is a JSON document in a string — a TEXT trapper item's value.
    let text = p["value"].as_str().expect("the value is a string");
    let v: Value = serde_json::from_str(text).expect("the value parses as JSON");
    assert_eq!(v["schema"], json!(1));
    assert_eq!(v["version"], json!(elasticpro_core::VERSION));
    assert_eq!(v["clock"], p["clock"], "the item's clock is the snapshot's");
    for path in [&v["inflight"]["total"], &v["queued"]["total"], &v["refused"]["total"], &v["requests_per_min"],
                 &v["memory"]["cache_budget_bytes"], &v["shared"], &v["cached"], &v["too_large"]] {
        assert!(path.is_u64(), "{path} in {v}");
    }
    // No address, no token, nothing about Zabbix itself in what is pushed.
    assert!(!text.contains("://") && !text.contains(TOKEN) && !text.contains("127.0.0.1"), "{text}");

    let s = admin(&c).await;
    let st = push_status(&c, &s).await;
    assert_eq!(st["enabled"], json!(true));
    assert_eq!(st["host"], json!("ElasticPro"));
    assert_eq!(st["credential"], json!("link"), "no override file: the paired token signs the push: {st}");
    assert!(hits.iter().all(|h| h.header("authorization") == Some(format!("Bearer {TOKEN}").as_str())),
            "every push carries the link's token");
    assert!(st["pushes"].as_u64().unwrap() >= 1, "{st}");
    assert_eq!(st["failures"], json!(0));
    assert!(st["lastOkAt"].as_u64().is_some(), "{st}");
    assert!(st["idle"].is_null(), "{st}");
}

#[tokio::test]
async fn a_refused_value_is_a_failure_that_backs_off() {
    let refuse = Arc::new(AtomicBool::new(true));
    let z = mock_zabbix(refuse.clone()).await;
    let dir = TempDir::new("zpush-fail");
    let c = core(&dir, Some(format!("{}/api_jsonrpc.php", z.url())), Some(TOKEN));
    let every = Duration::from_millis(80);
    c.start_zabbix_push_with(Some("ElasticPro".into()), None, every);
    let first = calls(&z, 1).await.len();
    assert_eq!(first, 1);
    // After one failure the next try waits twice the interval: nothing in the first
    // interval after the failure.
    tokio::time::sleep(every).await;
    assert_eq!(z.hits().len(), 1, "a failure backs off rather than retrying at the interval");
    let s = admin(&c).await;
    let st = push_status(&c, &s).await;
    assert!(st["failures"].as_u64().unwrap() >= 1, "{st}");
    assert!(st["consecutiveFailures"].as_u64().unwrap() >= 1, "{st}");
    assert!(st["lastError"].as_str().unwrap_or("").contains("No permissions"), "Zabbix's reason, verbatim: {st}");
    // Zabbix takes values again: the next push succeeds and the run of failures ends.
    refuse.store(false, Ordering::SeqCst);
    let before = z.hits().len();
    calls(&z, before + 1).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    let st = push_status(&c, &s).await;
    assert_eq!(st["consecutiveFailures"], json!(0), "{st}");
    assert!(st["lastError"].is_null(), "{st}");
    assert!(st["pushes"].as_u64().unwrap() >= 1, "{st}");
}

#[tokio::test]
async fn a_token_of_its_own_signs_the_push_and_the_link_token_does_not() {
    const OWN: &str = "metrics-only-token-fedcba9876543210";
    let z = mock_zabbix_for(OWN, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("zpush-own");
    std::fs::write(dir.join("metrics-token"), format!("{OWN}\n")).unwrap();
    // The link has its own (read-only) token; the push must not use it.
    let c = core(&dir, Some(format!("{}/api_jsonrpc.php", z.url())), Some(TOKEN));
    c.start_zabbix_push_with(Some("ElasticPro".into()), Some(dir.join("metrics-token")), EVERY);
    let hits = calls(&z, 1).await;
    assert_eq!(hits[0].header("authorization"), Some(format!("Bearer {OWN}").as_str()));
    let s = admin(&c).await;
    let st = push_status(&c, &s).await;
    assert_eq!(st["credential"], json!("metrics"), "{st}");
    assert!(!st.to_string().contains(OWN), "the status never carries the token: {st}");

    // Named but empty: reported, and no fallback to the link's identity.
    let z2 = mock_zabbix(Arc::new(AtomicBool::new(false))).await;
    let dir2 = TempDir::new("zpush-own-empty");
    std::fs::write(dir2.join("metrics-token"), "\n").unwrap();
    let c2 = core(&dir2, Some(format!("{}/api_jsonrpc.php", z2.url())), Some(TOKEN));
    c2.start_zabbix_push_with(Some("ElasticPro".into()), Some(dir2.join("metrics-token")), EVERY);
    tokio::time::sleep(EVERY * 5).await;
    assert_eq!(z2.hits().len(), 0, "an empty token file: nothing sent with the link's token instead");
    let s2 = admin(&c2).await;
    let st2 = push_status(&c2, &s2).await;
    assert!(st2["idle"].as_str().unwrap_or("").contains("is empty"), "{st2}");
}
