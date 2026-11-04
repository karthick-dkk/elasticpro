//! The history store with config.txt permitting writes (`HISTORY_STORE_WRITES=true`), through
//! the real message API and real sockets. Its own binary: config.txt is loaded once per
//! process. `history_store_gate.rs` is the same store with the permission absent.
//!
//! What these prove:
//!
//!   * nothing is written until an admin armed it, and arming needs a passing test on the
//!     settings as they are now;
//!   * once armed, a collection's changed days and the day's capacity go to the store — in
//!     `_bulk`s into `<prefix>-*` with deterministic ids, after the template — and nothing is
//!     ever written to the monitored cluster, even with `readOnly: false`;
//!   * disarming stops the next tick;
//!   * the delay sink's history destination writes to the store, not to a cluster;
//!   * the guard holds at the chokepoint: a store request that is not one of its shapes is
//!     refused before a socket, and a store request never reaches a monitored cluster;
//!   * the store's credential never comes back out.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::http::EsRequest;
use elasticpro_core::settings::{self, Settings};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::history::{self as h, STORE_SECRET};
use support::TempDir;

fn init() {
    settings::init_with(Settings::parse("HISTORY_STORE_WRITES=true\n"));
}

fn core(dir: &TempDir) -> Arc<Core> {
    init();
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

async fn get(c: &Arc<Core>, s: &str) -> Value {
    c.handle(json!({ "type": "HISTORY_STORE_GET", "session": s })).await
}

async fn wait_queue(c: &Arc<Core>, s: &str, at_least: u64) -> Value {
    for _ in 0..400 {
        let g = get(c, s).await;
        if g["status"]["queue"].as_u64().unwrap_or(0) >= at_least {
            return g;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the queue never reached {at_least}: {}", get(c, s).await);
}

#[tokio::test]
async fn writes_wait_for_an_armed_switch_after_a_passing_test_and_reach_only_the_store() {
    let dir = TempDir::new("hist-write");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    // readOnly false: the monitored clusters' own switch is open, and still nothing of this
    // feature writes to one.
    h::prime(&c, &s, &prod.url(), false).await;

    let set = h::configure(&c, &s, &store.url()).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["permitted"], json!(true));
    assert_eq!(set["settings"]["passwordSet"], json!(true));
    assert!(!set.to_string().contains(STORE_SECRET), "the credential is never returned: {set}");
    let on_disk = std::fs::read_to_string(dir.join("history-store.json")).unwrap();
    assert!(!on_disk.contains(STORE_SECRET), "kept sealed on disk");

    // Gate 2 is closed until a test passed.
    let early = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(early["ok"], json!(false), "{early}");
    assert!(early["message"].as_str().unwrap().contains("Test connection"), "{early}");
    assert_eq!(store.connections(), 0, "configuring and refusing send nothing");

    let test = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    assert_eq!(test["ok"], json!(true), "{test}");
    assert_eq!(test["test"]["privileges"], json!({ "create_doc": true, "create_index": true, "read": true, "manage_index_templates": true }));
    assert_eq!(test["test"]["version"], json!("8.15.0"));
    assert_eq!(test["test"]["current"], json!(true));
    assert_eq!(test["armBlocked"], Value::Null);
    let auth = store.hits().iter().find(|x| x.path == "/").and_then(|x| x.header("authorization").map(String::from)).unwrap();
    assert!(auth.starts_with("Basic "), "the store's own credential, typed once: {auth}");
    assert!(h::writes(&store).is_empty(), "a test only reads: {:?}", h::writes(&store));

    // Not armed: a collection run queues nothing and a tick writes nothing.
    let skipped = c.history_tick().await;
    assert!(skipped["skipped"].as_str().unwrap().contains("Write history is off"), "{skipped}");

    let armed = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(armed["ok"], json!(true), "{armed}");
    assert_eq!(armed["armed"], json!(true));
    assert!(h::writes(&store).is_empty(), "arming sends nothing either");

    // The scheduled daily run: yesterday's day, then the day's capacity, into the queue.
    let started = c.volume_tick_at(h::local_late()).await;
    assert_eq!(started, vec!["prod".to_string()]);
    let g = wait_queue(&c, &s, 2).await;
    assert_eq!(g["status"]["queue"], json!(2), "{g}");

    let tick = c.history_tick().await;
    assert_eq!(tick["ok"], json!(true), "{tick}");
    assert_eq!(tick["written"], json!(2), "{tick}");
    let w = h::writes(&store);
    assert!(w[0].starts_with("PUT /_index_template/elasticpro-history-template"), "the template first: {w:?}");
    let template = store.hits().into_iter().find(|x| x.method == "PUT").unwrap();
    assert!(!template.body.contains("settings") && !template.body.contains("lifecycle"), "mappings only: {}", template.body);
    let bulks: Vec<_> = store.hits().into_iter().filter(|x| x.path == "/_bulk").collect();
    assert_eq!(bulks.len(), 2, "capacity in one bulk, the volume day in the cluster's own");
    let all = bulks.iter().map(|b| b.body.clone()).collect::<String>();
    let yday = h::dash(h::yesterday());
    let today = h::dash(h::today());
    assert!(all.contains(&format!(r#""_id":"prod|{yday}""#)) && all.contains(&format!(r#""_id":"prod|{today}""#)), "{all}");
    let ym = |d: &str| d[..7].replace('-', ".");
    assert!(all.contains(&format!(r#""_index":"elasticpro-history-volume-{}""#, ym(&yday))), "{all}");
    assert!(all.contains(&format!(r#""_index":"elasticpro-history-capacity-{}""#, ym(&today))), "{all}");
    assert!(all.contains(r#""eventBytes":300"#), "the day's measured figures: {all}");
    assert!(all.contains(r#""dataNodeDiskTotal":null"#), "nothing in the fleet cache: not measured, never 0: {all}");
    assert!(all.contains(r#""repositoryBytes":null"#));
    assert!(!all.to_lowercase().contains("shortfall") && !all.to_lowercase().contains("required"), "measures, not judgements");

    // The monitored cluster: searches only, whatever its readOnly says.
    assert!(h::writes(&prod).is_empty(), "the monitored cluster is never written: {:?}", h::writes(&prod));

    let g = get(&c, &s).await;
    assert_eq!(g["status"]["docsWritten"], json!(2), "{g}");
    assert_eq!(g["status"]["queue"], json!(0));
    assert!(g["status"]["templateAt"].is_u64());
    assert!(!g.to_string().contains(STORE_SECRET));

    // Disarmed: the next tick writes nothing, even with something waiting.
    let off = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": false })).await;
    assert_eq!(off["armed"], json!(false), "{off}");
    let r = c.handle(json!({ "type": "VOLUME_RUN", "session": &s, "clusterIds": ["prod"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let before = h::writes(&store).len();
    let tick = c.history_tick().await;
    assert!(tick["skipped"].is_string(), "{tick}");
    assert_eq!(h::writes(&store).len(), before, "disarming stops writes at the next tick");
}

#[tokio::test]
async fn copy_existing_history_sends_the_local_record_once_armed() {
    let dir = TempDir::new("hist-backfill");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    // A record made while the store was not armed: nothing queued for it.
    assert_eq!(c.handle(json!({ "type": "VOLUME_RUN", "session": &s, "clusterIds": ["prod"] })).await["ok"], json!(true));
    for _ in 0..400 {
        let d = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 14, "avgDays": 3 })).await;
        if d["status"]["running"] == json!(false) && d["days"].as_array().is_some_and(|a| !a.is_empty()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(get(&c, &s).await["status"]["queue"], json!(0), "a closed gate is not a backlog");
    let refused = c.handle(json!({ "type": "HISTORY_STORE_BACKFILL", "session": &s })).await;
    assert_eq!(refused["ok"], json!(false), "copying is writing: {refused}");

    c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    let started = c.handle(json!({ "type": "HISTORY_STORE_BACKFILL", "session": &s })).await;
    assert_eq!(started["ok"], json!(true), "{started}");
    let mut done = Value::Null;
    for _ in 0..400 {
        done = get(&c, &s).await["status"]["backfill"].clone();
        if done["running"] == json!(false) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(done["error"], Value::Null, "{done}");
    assert_eq!(done["done"], done["total"], "{done}");
    assert_eq!(done["docs"], json!(1), "{done}");
    let bulk = store.hits().into_iter().find(|x| x.path == "/_bulk").expect("a bulk");
    assert!(bulk.body.contains(&format!(r#""_id":"prod|{}""#, h::dash(h::yesterday()))), "{}", bulk.body);
}

#[tokio::test]
async fn new_settings_disarm_and_need_a_new_test() {
    let dir = TempDir::new("hist-rearm");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::configure(&c, &s, &store.url()).await;
    assert_eq!(c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await["ok"], json!(true));
    assert_eq!(c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await["armed"], json!(true));

    // Another prefix is other indices: the switch goes off and the old test no longer counts.
    let other = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": {
        "url": store.url(), "auth": "basic", "user": "writer", "prefix": "elasticpro-other" } })).await;
    assert_eq!(other["armed"], json!(false), "{other}");
    assert_eq!(other["test"]["current"], json!(false));
    assert_eq!(other["settings"]["passwordSet"], json!(true), "an empty password keeps the one held");
    let again = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(again["ok"], json!(false), "{again}");

    // Another address: the secret typed for the old one is not sent there.
    let moved = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": {
        "url": "http://127.0.0.1:1", "auth": "basic", "user": "writer" } })).await;
    assert_eq!(moved["settings"]["passwordSet"], json!(false), "{moved}");
    assert_eq!(moved["settings"]["passwordStale"], json!(true));
    let t = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    assert_eq!(t["ok"], json!(false));
    assert!(t["message"].as_str().unwrap().contains("type it again"), "{t}");
}

#[tokio::test]
async fn the_delay_sink_can_write_to_the_history_store_instead_of_a_cluster() {
    let dir = TempDir::new("hist-delay");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    // readOnly true: the cluster destination would be refused; the store has its own gates.
    h::prime(&c, &s, &prod.url(), true).await;
    let set = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s,
                               "config": { "enabled": true, "destination": "history", "everyHours": 2 } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    // Not armed: refused, naming the store's gate, and nothing measured.
    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert!(run["skipped"].as_str().unwrap_or("").contains("history store"), "{run}");
    assert_eq!(prod.connections(), 0);

    h::configure(&c, &s, &store.url()).await;
    c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    let g = c.handle(json!({ "type": "DELAY_SINK_GET", "session": &s })).await;
    assert_eq!(g["historyStore"]["armed"], json!(true), "{g}");
    assert_eq!(g["config"]["destination"], json!("history"));

    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(true), "{run}");
    assert_eq!(run["measured"], json!(1), "{run}");
    assert!(run["index"].as_str().unwrap().starts_with("elasticpro-history-delay-"), "{run}");
    let bulk = store.hits().into_iter().find(|x| x.path == "/_bulk").expect("a bulk to the store");
    assert!(bulk.body.contains(r#""_id":"prod|fw-1|"#) && bulk.body.contains(r#""delay_minutes":41"#), "{}", bulk.body);
    assert!(h::writes(&prod).is_empty(), "the measured cluster is only searched: {:?}", h::writes(&prod));
}

#[tokio::test]
async fn the_guard_holds_at_the_chokepoint() {
    let dir = TempDir::new("hist-guard");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), false).await;
    h::configure(&c, &s, &store.url()).await;
    c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    let before = store.connections();
    let prefix = Some("elasticpro-history".to_string());
    let req = |cluster: &str, method: &str, path: &str, body: Option<&str>| EsRequest {
        cluster_id: cluster.into(), method: method.into(), path: path.into(), body: body.map(String::from),
        history_prefix: prefix.clone(), ..EsRequest::default()
    };
    // Armed and permitted, still nothing but the store's own shapes — whatever cluster it names.
    for (m, p, b) in [("DELETE", "/elasticpro-history-volume-2026.11", None), ("POST", "/elasticpro-history-x/_delete_by_query", Some("{}")),
                      ("PUT", "/_ilm/policy/p", Some("{}")), ("POST", "/_bulk", Some("{\"delete\":{\"_index\":\"elasticpro-history-x\",\"_id\":\"1\"}}\n")),
                      ("POST", "/_bulk", Some("{\"index\":{\"_index\":\"logstash-x\"}}\n{}\n")), ("GET", "/_cat/indices", None)] {
        let res = c.es_req_as(req("prod", m, p, b)).await;
        assert_eq!(res["kind"], json!("blocked_readonly"), "{m} {p}: {res}");
    }
    assert_eq!(store.connections(), before, "refused before a socket");
    // A store request naming a monitored cluster still goes to the store, never to the cluster.
    let res = c.es_req_as(req("prod", "GET", "/", None)).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(prod.connections(), 0, "the monitored cluster saw none of it");
    // And a page cannot ask for the store's permission: `historyPrefix` is not read from the wire.
    let page = c.handle(json!({ "type": "ES", "session": &s, "clusterId": "prod", "method": "POST", "path": "/_bulk",
                                "body": "{\"index\":{\"_index\":\"elasticpro-history-x\"}}\n{}\n", "historyPrefix": "elasticpro-history" })).await;
    assert_ne!(page["url"].as_str().map(|u| u.starts_with(&store.url())), Some(true), "{page}");
    assert_eq!(store.hits().iter().filter(|x| x.path == "/_bulk").count(), 0);
}
