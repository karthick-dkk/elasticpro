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
//!   * the queue survives a prefix change, drops what the guard refuses and goes on, gives up a
//!     malformed document after a few tries, and forgets a stream that is turned off (F1, F8);
//!   * a new store gets its template; somebody else's template of the same name is not
//!     replaced (F2, F6);
//!   * a request that waited for its slot while the store was disarmed is not sent (F3);
//!   * a test whose settings changed while it ran does not count (F10);
//!   * the store is never a monitored cluster, never follows a redirect (F6, F12);
//!   * the delay sink's history destination writes to the store, not to a cluster;
//!   * the guard holds at the chokepoint, and the store's credential never comes back out.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::http::EsRequest;
use elasticpro_core::settings::{self, Settings};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::history::{self as h, PREFIX, STORE_SECRET};
use support::{GaugedServer, TempDir, TestServer};

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

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("{what}");
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

/// A collection run of "prod", finished.
async fn collect(c: &Arc<Core>, s: &str) {
    assert_eq!(c.handle(json!({ "type": "VOLUME_RUN", "session": s, "clusterIds": ["prod"] })).await["ok"], json!(true));
    for _ in 0..400 {
        let d = c.handle(json!({ "type": "VOLUME_DAILY", "session": s, "clusterId": "prod", "days": 14, "avgDays": 3 })).await;
        if d["status"]["running"] == json!(false) && d["days"].as_array().is_some_and(|a| !a.is_empty()) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the collection did not finish");
}

#[tokio::test]
async fn writes_wait_for_an_armed_switch_after_a_passing_test_and_reach_only_the_store() {
    let dir = TempDir::new("hist-write");
    let store = h::tls_store(h::fake()).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    // readOnly false: the monitored clusters' own switch is open, and still nothing of this
    // feature writes to one.
    h::prime(&c, &s, &prod.url(), false).await;

    // Gate 2 is closed until a test passed.
    let set = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": h::settings(&store.url(), "basic", PREFIX) })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["permitted"], json!(true));
    assert_eq!(set["settings"]["passwordSet"], json!(true));
    assert!(!set.to_string().contains(STORE_SECRET), "the credential is never returned: {set}");
    let on_disk = std::fs::read_to_string(dir.join("history-store.json")).unwrap();
    assert!(!on_disk.contains(STORE_SECRET), "kept sealed on disk");
    let early = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(early["ok"], json!(false), "{early}");
    assert!(early["message"].as_str().unwrap().contains("Test connection"), "{early}");

    let test = h::configure_tls(&c, &s, &store).await;
    assert_eq!(test["test"]["privileges"], json!({ "create_doc": true, "create_index": true, "read": true, "manage_index_templates": true }));
    assert_eq!(test["test"]["version"], json!("8.15.0"));
    assert_eq!(test["test"]["current"], json!(true));
    assert_eq!(test["armBlocked"], Value::Null);
    let auth = store.hits().iter().find(|x| x.path == "/").and_then(|x| x.header("authorization").map(String::from)).unwrap();
    assert!(auth.starts_with("Basic "), "the store's own credential, over https: {auth}");
    assert!(h::writes_of(&store.hits()).is_empty(), "a test only reads");

    // Not armed: a tick writes nothing.
    let skipped = c.history_tick().await;
    assert!(skipped["skipped"].as_str().unwrap().contains("Write history is off"), "{skipped}");

    let armed = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(armed["armed"], json!(true), "{armed}");
    assert!(h::writes_of(&store.hits()).is_empty(), "arming sends nothing either");

    // The scheduled daily run: yesterday's day, then the day's capacity, into the queue.
    let started = c.volume_tick_at(h::local_late()).await;
    assert_eq!(started, vec!["prod".to_string()]);
    let g = wait_queue(&c, &s, 2).await;
    assert_eq!(g["status"]["queue"], json!(2), "{g}");
    assert!(!dir.join("history-store-queue.json").exists(), "the queue file is written by the tick, not on every enqueue (F8)");

    let tick = c.history_tick().await;
    assert_eq!(tick["ok"], json!(true), "{tick}");
    assert_eq!(tick["written"], json!(2), "{tick}");
    assert!(dir.join("history-store-queue.json").exists(), "the tick writes the queue file");
    let w = h::writes_of(&store.hits());
    assert!(w[0].starts_with(&format!("PUT /_index_template/{PREFIX}-template?create=true")), "the template first, created never overwritten: {w:?}");
    let template = store.hits().into_iter().find(|x| x.method == "PUT").unwrap();
    assert!(!template.body.contains("settings") && !template.body.contains("lifecycle"), "mappings only: {}", template.body);
    let bulks: Vec<_> = store.hits().into_iter().filter(|x| x.path == "/_bulk").collect();
    assert_eq!(bulks.len(), 2, "capacity in one bulk, the volume day in the cluster's own");
    let all = bulks.iter().map(|b| b.body.clone()).collect::<String>();
    let yday = h::dash(h::yesterday());
    let today = h::dash(h::today());
    assert!(all.contains(&format!(r#""_id":"prod|{yday}""#)) && all.contains(&format!(r#""_id":"prod|{today}""#)), "{all}");
    let ym = |d: &str| d[..7].replace('-', ".");
    assert!(all.contains(&format!(r#""_index":"{PREFIX}-volume-{}""#, ym(&yday))), "{all}");
    assert!(all.contains(&format!(r#""_index":"{PREFIX}-capacity-{}""#, ym(&today))), "{all}");
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
    let before = h::writes_of(&store.hits()).len();
    let tick = c.history_tick().await;
    assert!(tick["skipped"].is_string(), "{tick}");
    assert_eq!(h::writes_of(&store.hits()).len(), before, "disarming stops writes at the next tick");
}

/// F1: the queue keeps the day, not the index; a prefix change sends it under the new prefix,
/// and a bulk the guard refuses is dropped and counted while the rest goes on.
#[tokio::test]
async fn a_prefix_change_does_not_strand_the_queue_and_a_refusal_does_not_stop_the_tick() {
    let dir = TempDir::new("hist-prefix");
    // A queue left by an earlier run: one document the guard can never send (its stream makes
    // no index name), and one ordinary day.
    let day = h::dash(h::yesterday());
    let queued = json!([
        [["BAD*", "prod", format!("prod|{day}")], { "day": day, "doc": { "day": day }, "tries": 0 }],
        [["volume", "prod", format!("prod|{day}")], { "day": day, "doc": { "clusterId": "prod", "day": day }, "tries": 0 }],
    ]);
    std::fs::write(dir.join("history-store-queue.json"), queued.to_string()).unwrap();
    let store = h::store(h::fake()).await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::configure(&c, &s, &store.url()).await;
    h::arm(&c, &s).await;
    // Another prefix: disarmed, tested and armed again.
    let moved = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": h::settings(&store.url(), "none", "ep-moved") })).await;
    assert_eq!(moved["armed"], json!(false), "{moved}");
    h::arm(&c, &s).await;
    let tick = c.history_tick().await;
    assert_eq!(tick["written"], json!(1), "{tick}");
    assert_eq!(tick["refused"], json!(1), "the refused one is dropped and counted: {tick}");
    assert_eq!(tick["queue"], json!(0), "nothing is stuck: {tick}");
    let bulk = store.hits().into_iter().find(|x| x.path == "/_bulk").expect("the good one was sent");
    assert!(bulk.body.contains(&format!(r#""_index":"ep-moved-volume-{}""#, &day[..7].replace('-', "."))), "under the prefix in force: {}", bulk.body);
    assert!(!bulk.body.contains("elasticpro-history"), "{}", bulk.body);
    assert_eq!(get(&c, &s).await["status"]["refused"], json!(1));
}

/// F2 / F6: a new store with the same prefix gets its template; a template of that name that is
/// not ElasticPro's is never replaced and nothing is written under it.
#[tokio::test]
async fn every_store_gets_its_template_and_somebody_elses_is_left_alone() {
    let dir = TempDir::new("hist-template");
    let (fa, fb) = (h::fake(), h::fake());
    let (a, b) = (h::store(fa.clone()).await, h::store(fb.clone()).await);
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &a.url()).await;
    h::arm(&c, &s).await;
    collect(&c, &s).await;
    assert_eq!(c.history_tick().await["written"], json!(1));
    assert!(fa.lock().unwrap().template.is_some());
    // The same prefix on another store: its template is created there too.
    h::configure(&c, &s, &b.url()).await;
    h::arm(&c, &s).await;
    let r = c.handle(json!({ "type": "VOLUME_RUN", "session": &s, "clusterIds": ["prod"] })).await;
    assert_eq!(r["ok"], json!(true));
    // Refresh now is once a minute: queue the day by a backfill instead.
    let back = c.handle(json!({ "type": "HISTORY_STORE_BACKFILL", "session": &s })).await;
    assert_eq!(back["ok"], json!(true), "{back}");
    wait_for("the copy to finish", || fb.lock().unwrap().template.is_some() && b.hits().iter().any(|x| x.path == "/_bulk")).await;
    assert!(b.hits().iter().any(|x| x.method == "PUT" && x.path.starts_with(&format!("/_index_template/{PREFIX}-template"))));

    // A store where a template of that name is somebody else's.
    let ff = h::fake();
    ff.lock().unwrap().foreign = true;
    let foreign = h::store(ff).await;
    h::configure(&c, &s, &foreign.url()).await;
    h::arm(&c, &s).await;
    let back = c.handle(json!({ "type": "HISTORY_STORE_BACKFILL", "session": &s })).await;
    assert_eq!(back["ok"], json!(true), "{back}");
    let mut done = Value::Null;
    for _ in 0..400 {
        done = get(&c, &s).await["status"]["backfill"].clone();
        if done["running"] == json!(false) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(done["error"].as_str().unwrap_or("").contains("not ElasticPro's"), "{done}");
    assert!(!foreign.hits().iter().any(|x| x.path == "/_bulk"), "nothing written under somebody else's template");
}

/// F3: a write that waited for its slot while Write history was turned off is not sent.
#[tokio::test]
async fn a_request_that_waited_through_a_disarm_is_not_sent() {
    use elasticpro_core::gate::RequestConfig;
    let dir = TempDir::new("hist-wait");
    let fs = h::fake();
    let store = h::store(fs.clone()).await;
    let slow = GaugedServer::start(|_| (200, r#"{"ok":1}"#.into(), 1_500)).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    let primed = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [
        { "id": "prod", "url": prod.url() }, { "id": "slow", "url": slow.url() } ] })).await;
    assert_eq!(primed["ok"], json!(true));
    h::configure(&c, &s, &store.url()).await;
    h::arm(&c, &s).await;
    collect(&c, &s).await;
    assert_eq!(get(&c, &s).await["status"]["queue"], json!(1));
    let mut cfg: RequestConfig = elasticpro_core::gate::config().clone();
    cfg.limits.global = 1;
    cfg.limits.background_reserve = 0;
    cfg.read_cache_secs = 0;
    cfg.limits = cfg.limits.normalised();
    c.set_request_config_for_tests(cfg);
    // One slot, held by a slow read of another cluster.
    let (c1, s1) = (c.clone(), s.clone());
    let holder = tokio::spawn(async move {
        c1.handle(json!({ "type": "ES", "session": s1, "clusterId": "slow", "method": "GET", "path": "/hold" })).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let c2 = c.clone();
    let tick = tokio::spawn(async move { c2.history_tick().await });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let off = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": false })).await;
    assert_eq!(off["armed"], json!(false));
    holder.await.unwrap();
    let tick = tick.await.unwrap();
    assert_eq!(tick["ok"], json!(false), "{tick}");
    assert!(tick.to_string().contains("not sent"), "{tick}");
    assert!(h::writes(&store).is_empty(), "the store got nothing: {:?}", h::writes(&store));
    assert_eq!(get(&c, &s).await["status"]["queue"], json!(1), "kept for when it is armed again");
}

/// F8: a document the store rejects as malformed is given up after a few tries; a stream turned
/// off takes its queue with it.
#[tokio::test]
async fn a_malformed_document_is_given_up_and_a_stream_turned_off_forgets_its_queue() {
    let dir = TempDir::new("hist-reject");
    let fs = h::fake();
    fs.lock().unwrap().reject = true;
    let store = h::store(fs).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    h::arm(&c, &s).await;
    collect(&c, &s).await;
    for n in 1..=3 {
        let t = c.history_tick().await;
        assert_eq!(t["written"], json!(0), "{t}");
        assert_eq!(t["queue"], json!(if n < 3 { 1 } else { 0 }), "try {n}: {t}");
    }
    let g = get(&c, &s).await;
    assert_eq!(g["status"]["rejected"], json!(1), "{g}");
    assert!(g["status"]["lastError"].as_str().unwrap().contains("given up"), "{g}");

    // Turning a stream off drops what waits for it.
    c.volume_tick_at(h::local_late()).await;
    wait_queue(&c, &s, 2).await;
    let mut cfg = h::settings(&store.url(), "none", PREFIX);
    cfg["streams"] = json!({ "volume": true, "capacity": false, "delay": true });
    let off = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": cfg })).await;
    assert_eq!(off["status"]["queue"], json!(1), "the capacity document went: {off}");
}

/// F10: a test is kept only for the settings it ran on.
#[tokio::test]
async fn a_test_whose_settings_changed_while_it_ran_does_not_count() {
    let dir = TempDir::new("hist-race");
    let fs = h::fake();
    let slow = GaugedServer::start(move |hit| {
        let (st, body) = h::respond(&fs, hit);
        (st, body, if hit.path == "/" { 800 } else { 0 })
    }).await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::configure(&c, &s, &slow.url()).await;
    let (c1, s1) = (c.clone(), s.clone());
    let test = tokio::spawn(async move { c1.handle(json!({ "type": "HISTORY_STORE_TEST", "session": s1 })).await });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let other = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": h::settings(&slow.url(), "none", "ep-other") })).await;
    assert_eq!(other["ok"], json!(true));
    let test = test.await.unwrap();
    assert_eq!(test["ok"], json!(false), "{test}");
    assert!(test["message"].as_str().unwrap().contains("changed while the test ran"), "{test}");
    assert_eq!(test["test"], Value::Null, "nothing kept to arm on: {test}");
    let arm = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(arm["ok"], json!(false), "{arm}");
}

/// F6 / F12 / F15: the store is never a monitored cluster, never follows a redirect, never takes
/// a credential over plain http, and a new kind of credential must be typed.
#[tokio::test]
async fn the_store_is_dedicated_stays_where_it_is_and_takes_a_credential_only_over_https() {
    let dir = TempDir::new("hist-dedicated");
    let prod = h::cluster().await;
    let elsewhere = TestServer::start().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    let same = h::configure(&c, &s, &prod.url()).await;
    assert_eq!(same["ok"], json!(false), "{same}");
    assert!(same["message"].as_str().unwrap().contains("monitored cluster"), "{same}");
    let logs = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": h::settings("http://127.0.0.1:1", "none", "logs") })).await;
    assert_eq!(logs["ok"], json!(false), "a prefix that would capture logs-*: {logs}");
    let plain = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": h::settings("http://127.0.0.1:1", "basic", PREFIX) })).await;
    assert_eq!(plain["ok"], json!(false), "{plain}");
    assert!(plain["message"].as_str().unwrap().contains("https://"), "{plain}");

    // A redirect is an answer, not a new destination.
    let hop = h::redirect_to(&elsewhere.url()).await;
    h::configure(&c, &s, &format!("http://127.0.0.1:{hop}")).await;
    let t = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    assert_eq!(t["ok"], json!(false), "{t}");
    assert_eq!(elsewhere.connections(), 0, "the redirect was not followed");

    // Basic -> API key: the password is not an API key.
    let tls = h::tls_store(h::fake()).await;
    h::configure_tls(&c, &s, &tls).await;
    let mut key = h::settings(&tls.url(), "apiKey", PREFIX);
    key.as_object_mut().unwrap().remove("password");
    let switched = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": key })).await;
    assert_eq!(switched["settings"]["passwordStale"], json!(true), "{switched}");
    let t = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    assert!(t["message"].as_str().unwrap().contains("type it again"), "{t}");
}

#[tokio::test]
async fn new_settings_disarm_and_need_a_new_test() {
    let dir = TempDir::new("hist-rearm");
    let store = h::tls_store(h::fake()).await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::configure_tls(&c, &s, &store).await;
    assert_eq!(c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await["armed"], json!(true));

    // Another prefix is other indices: the switch goes off and the old test no longer counts.
    let mut other = h::settings(&store.url(), "basic", "elasticpro-other");
    other.as_object_mut().unwrap().remove("password");
    let other = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": other })).await;
    assert_eq!(other["armed"], json!(false), "{other}");
    assert_eq!(other["test"]["current"], json!(false));
    assert_eq!(other["settings"]["passwordSet"], json!(true), "an empty password keeps the one held");
    let again = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(again["ok"], json!(false), "{again}");

    // Another address: the secret typed for the old one is not sent there.
    let mut moved = h::settings("https://localhost:1", "basic", PREFIX);
    moved.as_object_mut().unwrap().remove("password");
    let moved = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": &s, "settings": moved })).await;
    assert_eq!(moved["settings"]["passwordSet"], json!(false), "{moved}");
    assert_eq!(moved["settings"]["passwordStale"], json!(true));
    let t = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    assert_eq!(t["ok"], json!(false));
    assert!(t["message"].as_str().unwrap().contains("type it again"), "{t}");
}

#[tokio::test]
async fn copy_existing_history_sends_the_local_record_once_armed() {
    let dir = TempDir::new("hist-backfill");
    let store = h::store(h::fake()).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    // A record made while the store was not armed: nothing queued for it.
    collect(&c, &s).await;
    assert_eq!(get(&c, &s).await["status"]["queue"], json!(0), "a closed gate is not a backlog");
    let refused = c.handle(json!({ "type": "HISTORY_STORE_BACKFILL", "session": &s })).await;
    assert_eq!(refused["ok"], json!(false), "copying is writing: {refused}");

    h::arm(&c, &s).await;
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
async fn the_delay_sink_can_write_to_the_history_store_instead_of_a_cluster() {
    let dir = TempDir::new("hist-delay");
    let store = h::store(h::fake()).await;
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
    h::arm(&c, &s).await;
    let g = c.handle(json!({ "type": "DELAY_SINK_GET", "session": &s })).await;
    assert_eq!(g["historyStore"]["armed"], json!(true), "{g}");
    assert_eq!(g["config"]["destination"], json!("history"));

    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(true), "{run}");
    assert_eq!(run["measured"], json!(1), "{run}");
    assert!(run["index"].as_str().unwrap().starts_with(&format!("{PREFIX}-delay-")), "{run}");
    let bulk = store.hits().into_iter().find(|x| x.path == "/_bulk").expect("a bulk to the store");
    assert!(bulk.body.contains(r#""_id":"prod|fw-1|"#) && bulk.body.contains(r#""delay_minutes":41"#), "{}", bulk.body);
    assert!(h::writes(&prod).is_empty(), "the measured cluster is only searched: {:?}", h::writes(&prod));
}

#[tokio::test]
async fn the_guard_holds_at_the_chokepoint() {
    let dir = TempDir::new("hist-guard");
    let store = h::store(h::fake()).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), false).await;
    h::configure(&c, &s, &store.url()).await;
    h::arm(&c, &s).await;
    let before = store.connections();
    let prefix = Some(PREFIX.to_string());
    let req = |cluster: &str, method: &str, path: &str, body: Option<&str>| EsRequest {
        cluster_id: cluster.into(), method: method.into(), path: path.into(), body: body.map(String::from),
        history_prefix: prefix.clone(), ..EsRequest::default()
    };
    // Armed and permitted, still nothing but the store's own shapes — whatever cluster it names.
    for (m, p, b) in [("DELETE", "/elasticpro-history-volume-2026.11", None), ("POST", "/elasticpro-history-x/_delete_by_query", Some("{}")),
                      ("PUT", "/_ilm/policy/p", Some("{}")), ("POST", "/_bulk", Some("{\"delete\":{\"_index\":\"elasticpro-history-x\",\"_id\":\"1\"}}\n")),
                      ("POST", "/_bulk", Some("{\"index\":{\"_index\":\"logstash-x\"}}\n{}\n")), ("GET", "/_cat/indices", None),
                      ("POST", "/_bulk", Some("{\"index\":{\"_index\":\"elasticpro-history-x\",\"_id\":\"a\"}}\n\n{\"delete\":{\"_index\":\"elasticpro-history-x\",\"_id\":\"b\"}}\n{}\n")),
                      ("PUT", "/_index_template/elasticpro-history-template", Some("{}"))] {
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
                                "body": "{\"index\":{\"_index\":\"elasticpro-history-x\"}}\n{}\n", "historyPrefix": PREFIX })).await;
    assert_ne!(page["url"].as_str().map(|u| u.starts_with(&store.url())), Some(true), "{page}");
    assert_eq!(store.hits().iter().filter(|x| x.path == "/_bulk").count(), 0);
}
