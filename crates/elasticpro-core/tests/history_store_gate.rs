//! The history store **without** `HISTORY_STORE_WRITES=true` in config.txt (its own binary:
//! config.txt is loaded once per process, and here it is never loaded at all).
//!
//!   * the store can be configured and tested, never written: arming is refused, naming the
//!     setting; a tick writes nothing — counted on the store's socket;
//!   * reading back needs no write gate: a day the local record does not hold comes from the
//!     store marked `source: "history"`; a store that cannot be reached says so, never 0;
//!   * the desktop editions have no store; the messages need an admin (HISTORY_QUERY a user);
//!     a limited admin may not change it.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::history::{self as h, STORE_SECRET};
use support::TempDir;

fn hosted(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

#[tokio::test]
async fn without_the_config_permission_the_store_is_tested_but_never_written() {
    let dir = TempDir::new("histg-permit");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    let set = h::configure(&c, &s, &store.url()).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["permitted"], json!(false));
    assert_eq!(set["permitHint"], json!("set HISTORY_STORE_WRITES=true in config.txt"));
    assert_eq!(set["armBlocked"], json!("set HISTORY_STORE_WRITES=true in config.txt"));

    let test = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": &s })).await;
    assert_eq!(test["ok"], json!(true), "testing is reading: {test}");
    let arm = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": &s, "on": true })).await;
    assert_eq!(arm["ok"], json!(false), "{arm}");
    assert!(arm["message"].as_str().unwrap().contains("HISTORY_STORE_WRITES=true"), "{arm}");

    let tick = c.history_tick().await;
    assert!(tick["skipped"].as_str().unwrap().contains("HISTORY_STORE_WRITES"), "{tick}");
    let back = c.handle(json!({ "type": "HISTORY_STORE_BACKFILL", "session": &s })).await;
    assert_eq!(back["ok"], json!(false), "{back}");
    assert!(h::writes(&store).is_empty(), "nothing written: {:?}", h::writes(&store));
}

#[tokio::test]
async fn days_the_local_record_lacks_come_from_the_store_marked_as_such() {
    let dir = TempDir::new("histg-read");
    let old = h::today() - chrono::Duration::days(40);
    let older = h::today() - chrono::Duration::days(41);
    let docs = Arc::new(Mutex::new(vec![h::volume_doc("prod", old, 7), h::volume_doc("prod", older, 5), h::volume_doc("other", old, 99)]));
    let store = h::store(docs).await;
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;

    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 60, "avgDays": 3 })).await;
    assert_eq!(daily["ok"], json!(true), "{daily}");
    assert_eq!(daily["history"]["reachable"], json!(true), "{daily}");
    let rows = daily["days"].as_array().unwrap();
    let r = rows.iter().find(|r| r["day"] == json!(h::dash(old))).unwrap_or_else(|| panic!("{daily}"));
    assert_eq!(r["source"], json!("history"));
    assert_eq!(r["docs"], json!(7));
    assert_eq!(r["eventBytes"], json!(21));
    assert_eq!(rows.len(), 2, "another cluster's days are not this one's: {daily}");
    let search = store.hits().into_iter().find(|x| x.path.contains("/_search")).unwrap();
    assert!(search.path.starts_with("/elasticpro-history-volume-*/_search"), "{}", search.path);
    assert_eq!(store.hits().iter().filter(|x| x.path.contains("/_search")).count(), 1, "one search per request");

    let monthly = c.handle(json!({ "type": "VOLUME_MONTHLY", "session": &s, "clusterId": "prod", "months": 3 })).await;
    let hist: Vec<&Value> = monthly["months"].as_array().unwrap().iter().filter(|m| m["source"] == json!("history")).collect();
    assert!(!hist.is_empty(), "{monthly}");
    assert_eq!(hist.iter().map(|m| m["docs"].as_u64().unwrap()).sum::<u64>(), 12, "{monthly}");

    let all = c.handle(json!({ "type": "VOLUME_MONTHLY_ALL", "session": &s, "months": 3 })).await;
    assert_eq!(all["history"]["reachable"], json!(true), "{all}");

    let q = c.handle(json!({ "type": "HISTORY_QUERY", "session": &s, "stream": "volume", "clusterId": "prod",
                             "from": h::dash(older), "to": h::dash(old) })).await;
    assert_eq!(q["ok"], json!(true), "{q}");
    assert_eq!(q["docs"].as_array().unwrap().len(), 3, "the store's answer, as it is: {q}");
    assert!(h::writes(&store).is_empty(), "reading back writes nothing");
}

#[tokio::test]
async fn an_unreachable_store_says_so_and_shows_no_zeroes() {
    let dir = TempDir::new("histg-down");
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    let dead = support::dead_port().await;
    h::configure(&c, &s, &format!("http://127.0.0.1:{dead}")).await;
    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 30, "avgDays": 3 })).await;
    assert_eq!(daily["ok"], json!(true), "the local record still answers: {daily}");
    assert_eq!(daily["history"]["reachable"], json!(false), "{daily}");
    assert!(daily["history"]["message"].as_str().unwrap().starts_with("in the history store · not reachable"), "{daily}");
    assert_eq!(daily["days"], json!([]), "no day is made up: {daily}");
    let q = c.handle(json!({ "type": "HISTORY_QUERY", "session": &s, "stream": "capacity", "clusterId": "prod" })).await;
    assert_eq!(q["ok"], json!(false));
    assert!(q["message"].as_str().unwrap().contains("not reachable"), "{q}");
}

#[tokio::test]
async fn the_desktop_editions_have_no_store() {
    let dir = TempDir::new("histg-portable");
    let p = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    for t in ["HISTORY_STORE_GET", "HISTORY_STORE_SET", "HISTORY_STORE_TEST", "HISTORY_STORE_ARM", "HISTORY_STORE_BACKFILL", "HISTORY_QUERY"] {
        let res = p.handle(json!({ "type": t, "settings": { "url": "http://x:9200" }, "on": true })).await;
        assert_eq!(res["supported"], json!(false), "{t}: {res}");
    }
    assert!(!dir.join("history-store.json").exists(), "nothing saved for a later hosted run to pick up");
    let dir = TempDir::new("histg-installed");
    let i = Core::new_with_rounds(Some(dir.0.clone()), Edition::Installed, 1);
    let s = h::admin(&i).await;
    let res = i.handle(json!({ "type": "HISTORY_STORE_GET", "session": &s })).await;
    assert_eq!(res["supported"], json!(false), "{res}");
}

#[tokio::test]
async fn every_message_needs_the_right_caller_and_never_echoes_the_secret() {
    let dir = TempDir::new("histg-auth");
    let store = h::store(Arc::new(Mutex::new(vec![]))).await;
    let c = hosted(&dir);
    for t in ["HISTORY_STORE_GET", "HISTORY_STORE_SET", "HISTORY_STORE_TEST", "HISTORY_STORE_ARM", "HISTORY_STORE_BACKFILL", "HISTORY_QUERY"] {
        let res = c.handle(json!({ "type": t })).await;
        assert!(res["kind"] == json!("unauthenticated") || res["kind"] == json!("needs_bootstrap"), "{t}: {res}");
    }
    let s = h::admin(&c).await;
    h::configure(&c, &s, &store.url()).await;
    for role in ["operator", "user"] {
        let add = c.handle(json!({ "type": "USER_ADD", "session": &s, "name": role, "password": h::PASSWORD, "role": role })).await;
        assert_eq!(add["ok"], json!(true), "{add}");
        let login = c.handle(json!({ "type": "LOGIN", "name": role, "password": h::PASSWORD })).await;
        let rs = login["session"].as_str().unwrap().to_string();
        for t in ["HISTORY_STORE_GET", "HISTORY_STORE_SET", "HISTORY_STORE_TEST", "HISTORY_STORE_ARM", "HISTORY_STORE_BACKFILL"] {
            let res = c.handle(json!({ "type": t, "session": &rs })).await;
            assert!(res["kind"] == json!("forbidden") || res["kind"] == json!("must_change_password"), "{role} {t}: {res}");
        }
    }
    // The secret is in no reply and no file but sealed.
    for t in ["HISTORY_STORE_GET", "HISTORY_STORE_TEST"] {
        let res = c.handle(json!({ "type": t, "session": &s })).await;
        assert!(!res.to_string().contains(STORE_SECRET), "{t}: {res}");
    }
    for e in std::fs::read_dir(&dir.0).unwrap().flatten() {
        if e.path().is_file() {
            let text = String::from_utf8_lossy(&std::fs::read(e.path()).unwrap()).to_string();
            assert!(!text.contains(STORE_SECRET), "{} holds the secret in the clear", e.path().display());
        }
    }
}
