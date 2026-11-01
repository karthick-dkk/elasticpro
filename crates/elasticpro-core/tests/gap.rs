//! Duplicate requests, end to end (the request policy's `minGapSec`): what reaches a cluster
//! when the same request is asked for again inside the gap, from a page's own read and from a
//! fleet dataset; what is never held (the kinds a person types); and that askers for a
//! request already on its way share it. Counted on the server's side of the socket.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use support::{GaugedServer, TempDir, TestServer};

async fn primed(dir: &TempDir, url: &str) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "es", "url": url }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c
}

fn get(path: &str) -> Value {
    json!({ "type": "ES", "clusterId": "es", "method": "GET", "path": path, "origin": "page:overview", "timeoutMs": 15000 })
}

fn hits_on(srv: &TestServer, path: &str) -> usize {
    srv.hits().iter().filter(|h| h.path == path).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_askers_inside_the_gap_make_one_request_and_after_it_a_new_one_goes() {
    let dir = TempDir::new("gap-direct");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url()).await;
    // The read cache's own seconds off: whatever is answered from memory here is the gap's.
    let mut cfg = c.request_config();
    cfg.read_cache_secs = 0;
    c.set_request_config_for_tests(cfg);
    let a = c.handle(get("/_cat/nodes")).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    assert!(a.get("cached").is_none());
    // Another page, and a Refresh (maxAgeMs 0), inside the shipped minute: that reading.
    let b = c.handle(get("/_cat/nodes")).await;
    assert_eq!(b["cached"], json!(true), "{b}");
    let mut refresh = get("/_cat/nodes");
    refresh["maxAgeMs"] = json!(0);
    let r = c.handle(refresh).await;
    assert_eq!(r["cached"], json!(true), "a Refresh inside the gap gets the reading, with its age: {r}");
    assert!(r["ageMs"].as_u64().is_some());
    assert_eq!(hits_on(&srv, "/_cat/nodes"), 1, "one request for three askers");
    // Once the gap has passed, the next request goes.
    c.set_min_gap_for_tests(150);
    tokio::time::sleep(Duration::from_millis(250)).await;
    let d = c.handle(get("/_cat/nodes")).await;
    assert!(d.get("cached").is_none(), "past the gap: {d}");
    assert_eq!(hits_on(&srv, "/_cat/nodes"), 2);
    // The Request Centre's figures say so.
    let log = c.handle(json!({ "type": "REQUEST_LOG", "limit": 50 })).await;
    let direct = &log["asks"]["byDataset"]["direct"];
    assert_eq!((direct["sent"].clone(), direct["recent"].clone()), (json!(2), json!(2)), "{}", log["asks"]);
    assert_eq!(direct["asked"], json!(4));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_a_person_types_is_never_held_nor_shared() {
    let dir = TempDir::new("gap-exempt");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url()).await;
    let path = "/_snapshot/repo/_all?verbose=true";
    // A page read it a moment ago: the gap would answer anybody else from that reading.
    let _ = c.handle(get(path)).await;
    assert_eq!(hits_on(&srv, path), 1);
    for purpose in ["console", "index-search", "snapshot-search"] {
        let mut m = get(path);
        m["purpose"] = json!(purpose);
        let r = c.handle(m).await;
        assert!(r.get("cached").is_none() && r.get("shared").is_none(), "{purpose} went to the cluster: {r}");
    }
    assert_eq!(hits_on(&srv, path), 4, "each of the three exempt kinds sent its own");
    // The console by its origin too, as it always was.
    let mut console = get(path);
    console["origin"] = json!("console");
    assert!(c.handle(console).await.get("cached").is_none());
    assert_eq!(hits_on(&srv, path), 5);
    // A purpose nobody exempted is held like any page read.
    let mut other = get(path);
    other["purpose"] = json!("refresh");
    assert_eq!(c.handle(other).await["cached"], json!(true));
    assert_eq!(hits_on(&srv, path), 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_askers_share_the_one_on_its_way() {
    let dir = TempDir::new("gap-flight");
    let srv = GaugedServer::start(|_| (200, r#"{"ok":1}"#.into(), 300)).await;
    let c = primed(&dir, &srv.url()).await;
    let all: Vec<_> = (0..6).map(|_| {
        let c = c.clone();
        tokio::spawn(async move { c.handle(get("/_cat/indices")).await })
    }).collect();
    let mut shared = 0;
    for t in all {
        let r = t.await.unwrap();
        assert_eq!(r["ok"], json!(true), "{r}");
        if r["shared"] == json!(true) {
            shared += 1;
        }
    }
    assert_eq!(srv.hits().len(), 1, "six askers, one request");
    assert_eq!(shared, 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dataset_answered_inside_the_gap_is_that_reading_for_every_asker() {
    let dir = TempDir::new("gap-dataset");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url()).await;
    c.start_fleet_poller();
    let ask = |max: u64| json!({ "type": "CLUSTER_DATASET", "clusterId": "es", "dataset": "nodes", "maxAgeSec": max, "wait": true });
    let a = c.handle(ask(0)).await;
    assert_eq!(a["entry"]["status"], json!("ok"), "{a}");
    let first = hits_on(&srv, "/_cat/allocation?format=json&bytes=b");
    assert_eq!(first, 1);
    // A Retry asking for nothing older than 0 s, a second later: the reading, no request.
    let b = c.handle(ask(0)).await;
    assert_eq!(b["waited"], json!(false), "{b}");
    assert_eq!(b["entry"]["fetchedAt"], a["entry"]["fetchedAt"]);
    // A Refresh too: skipped as recent, with when the next may go.
    let r = c.handle(json!({ "type": "REFRESH", "clusterIds": ["es"], "datasets": ["nodes"] })).await;
    assert_eq!(r["queued"], json!(0), "{r}");
    assert_eq!(r["skipped"][0]["reason"], json!("recent"));
    assert!(r["skipped"][0]["nextAt"].as_u64().is_some());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(hits_on(&srv, "/_cat/allocation?format=json&bytes=b"), 1, "nothing more reached the cluster");
    let log = c.handle(json!({ "type": "REQUEST_LOG", "limit": 10 })).await;
    let nodes = &log["asks"]["byDataset"]["nodes"];
    assert_eq!((nodes["sent"].clone(), nodes["recent"].clone()), (json!(1), json!(2)), "{}", log["asks"]);
    // The policy's gap and the Play schedule ride along with FLEET_STATE for the pages.
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["minGapSec"], json!(60));
    assert_eq!(st["policy"]["play"]["delayFullSec"], json!(7200));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn play_says_what_it_shows_and_the_core_keeps_it_coming_at_plays_pace() {
    let dir = TempDir::new("gap-play");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url()).await;
    c.start_fleet_poller();
    // A display's minute: Play-watched, and fetched at once only because it never was.
    let w = json!({ "type": "REFRESH", "clusterIds": ["es"], "datasets": ["health", "indices"], "watcher": "play" });
    let r = c.handle(w.clone()).await;
    assert_eq!(r["queued"], json!(2), "{r}");
    for _ in 0..100 {
        if hits_on(&srv, "/_cluster/health") >= 1 && srv.hits().iter().any(|h| h.path.starts_with("/_cat/indices")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let before = srv.hits().len();
    // The next minute: nothing new is asked — the pace is the core's (5 min, 1 h).
    let r = c.handle(w).await;
    assert_eq!(r["queued"], json!(0), "{r}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(srv.hits().len(), before, "{:?}", srv.hits().iter().map(|h| h.path.clone()).collect::<Vec<_>>());
}
