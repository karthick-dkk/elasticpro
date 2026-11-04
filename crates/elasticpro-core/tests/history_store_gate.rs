//! The history store **without** `HISTORY_STORE_WRITES=true` in config.txt (its own binary:
//! config.txt is loaded once per process, and here it is never loaded at all).
//!
//!   * the store can be configured and tested, never written: arming is refused, naming the
//!     setting; a tick writes nothing — counted on the store's socket; a start without the key
//!     disarms a store armed before (F14);
//!   * reading back needs no write gate: a day the local record does not hold comes from the
//!     store marked `source: "history"`; Monthly merges the store's days into the month the
//!     local record starts in and agrees with Daily (F4); a bounded read-back says where it
//!     stopped and marks those months incomplete (F5); a store with nothing written says so
//!     (F2); a store that cannot be reached says so, never 0, is not asked again for a minute,
//!     and a display link never waits on it (F7);
//!   * the desktop editions have no store; the messages need an admin (HISTORY_QUERY a user); a
//!     limited admin may not change it, nor the delay schedule, and is held to their clusters
//!     for HISTORY_QUERY and the volume record (F11, F13).

mod support;

use chrono::{Datelike, Duration, NaiveDate};
use elasticpro_core::auth::{Caller, Edition, PlayCaller, Role};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::history::{self as h, PREFIX, STORE_SECRET};
use support::TempDir;

fn hosted(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

fn searches(srv: &support::TestServer) -> usize {
    srv.hits().iter().filter(|x| x.path.contains("/_search")).count()
}

async fn collect(c: &Arc<Core>, s: &str) {
    assert_eq!(c.handle(json!({ "type": "VOLUME_RUN", "session": s, "clusterIds": ["prod"] })).await["ok"], json!(true));
    for _ in 0..400 {
        let d = c.handle(json!({ "type": "VOLUME_DAILY", "session": s, "clusterId": "prod", "days": 14, "avgDays": 3 })).await;
        if d["status"]["running"] == json!(false) && d["days"].as_array().is_some_and(|a| a.iter().any(|r| r["source"].is_null())) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the collection did not finish");
}

fn month_start(m: &str) -> NaiveDate {
    NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").unwrap()
}

#[tokio::test]
async fn without_the_config_permission_the_store_is_tested_but_never_written() {
    let dir = TempDir::new("histg-permit");
    let store = h::store(h::fake()).await;
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

/// F14: a store armed under an earlier config.txt is disarmed by a start without the key.
#[tokio::test]
async fn a_start_without_the_permission_disarms() {
    let dir = TempDir::new("histg-disarm");
    std::fs::write(dir.join("history-store.json"), json!({ "version": 1, "url": "http://127.0.0.1:1", "auth": "none", "armed": true,
                                                            "armedBy": "admin" }).to_string()).unwrap();
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    let g = c.handle(json!({ "type": "HISTORY_STORE_GET", "session": &s })).await;
    assert_eq!(g["armed"], json!(false), "putting the key back needs a new decision: {g}");
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("history-store.json")).unwrap()).unwrap();
    assert_eq!(on_disk["armed"], json!(false));
}

#[tokio::test]
async fn days_the_local_record_lacks_come_from_the_store_marked_as_such() {
    let dir = TempDir::new("histg-read");
    let old = h::today() - Duration::days(40);
    let older = h::today() - Duration::days(41);
    let store = h::store(h::fake_with(vec![h::volume_doc("prod", old, 7), h::volume_doc("prod", older, 5), h::volume_doc("other", old, 99)])).await;
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
    assert!(search.path.starts_with(&format!("/{PREFIX}-volume-*/_search")), "{}", search.path);
    assert!(search.header("x-opaque-id").is_some_and(|v| v.contains("history-store")));

    let all = c.handle(json!({ "type": "VOLUME_MONTHLY_ALL", "session": &s, "months": 3 })).await;
    assert_eq!(all["history"]["reachable"], json!(true), "{all}");

    let q = c.handle(json!({ "type": "HISTORY_QUERY", "session": &s, "stream": "volume", "clusterId": "prod",
                             "from": h::dash(older), "to": h::dash(old) })).await;
    assert_eq!(q["ok"], json!(true), "{q}");
    assert_eq!(q["docs"].as_array().unwrap().len(), 3, "the store's answer, as it is: {q}");
    let missing = c.handle(json!({ "type": "HISTORY_QUERY", "session": &s, "stream": "volume", "clusterId": "gone" })).await;
    assert_eq!(missing["kind"], json!("not_found"), "the cluster must exist: {missing}");
    assert!(h::writes(&store).is_empty(), "reading back writes nothing");
}

/// F4: the month the local record starts in counts the store's earlier days of that month, a
/// local day wins over the store's, and Monthly agrees with Daily.
#[tokio::test]
async fn monthly_merges_per_day_and_agrees_with_daily() {
    let dir = TempDir::new("histg-merge");
    let y = h::yesterday();
    let before = y - Duration::days(1);
    // The store holds the day before the local record starts, and yesterday too (stale: 999).
    let store = h::store(h::fake_with(vec![h::volume_doc("prod", before, 7), h::volume_doc("prod", y, 999)])).await;
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    collect(&c, &s).await;

    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 30, "avgDays": 3 })).await;
    let drows = daily["days"].as_array().unwrap();
    let yrow = drows.iter().find(|r| r["day"] == json!(h::dash(y))).unwrap();
    assert_eq!((yrow["docs"].clone(), yrow["source"].clone()), (json!(100), Value::Null), "a local day wins: {daily}");
    let brow = drows.iter().find(|r| r["day"] == json!(h::dash(before))).unwrap();
    assert_eq!((brow["docs"].clone(), brow["source"].clone()), (json!(7), json!("history")), "{daily}");

    let monthly = c.handle(json!({ "type": "VOLUME_MONTHLY", "session": &s, "clusterId": "prod", "months": 3 })).await;
    for m in monthly["months"].as_array().unwrap() {
        let key = m["month"].as_str().unwrap();
        let from_daily: u64 = drows.iter().filter(|r| r["day"].as_str().unwrap().starts_with(key)).map(|r| r["docs"].as_u64().unwrap_or(0)).sum();
        assert_eq!(m["docs"].as_u64().unwrap_or(0), from_daily, "Monthly agrees with Daily for {key}: {monthly}");
    }
    let ym = |d: NaiveDate| format!("{:04}-{:02}", d.year(), d.month());
    let row = monthly["months"].as_array().unwrap().iter().find(|m| m["month"] == json!(ym(y))).unwrap().clone();
    if ym(before) == ym(y) {
        assert_eq!((row["docs"].clone(), row["historyDays"].clone()), (json!(107), json!(1)), "{row}");
    } else {
        assert_eq!(row["docs"], json!(100));
        let prev = monthly["months"].as_array().unwrap().iter().find(|m| m["month"] == json!(ym(before))).unwrap();
        assert_eq!((prev["docs"].clone(), prev["source"].clone()), (json!(7), json!("history")), "{prev}");
    }
}

/// F5: a read-back that reaches its bound pages, stops, says where, and marks the months it
/// could not read in full as incomplete.
#[tokio::test]
async fn a_bounded_read_back_says_where_it_stopped() {
    let dir = TempDir::new("histg-bound");
    let fs = h::fake();
    fs.lock().unwrap().paged_total = Some(60_000);
    let store = h::store(fs).await;
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    let all = c.handle(json!({ "type": "VOLUME_MONTHLY_ALL", "session": &s, "months": 3 })).await;
    let hist = &all["history"];
    assert_eq!(hist["truncated"], json!(true), "{hist}");
    let cut = NaiveDate::parse_from_str(hist["truncatedBefore"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    assert_eq!(cut, h::today() - Duration::days(44), "five pages, one day older each: {hist}");
    assert_eq!(searches(&store), 5, "paged with search_after, bounded");
    assert!(store.hits().iter().skip(1).filter(|x| x.path.contains("/_search")).all(|x| x.body.contains("search_after")));
    let rows = all["clusters"][0]["months"].as_array().unwrap();
    let marked: Vec<&Value> = rows.iter().filter(|m| m["source"] == json!("history") || m["historyDays"].is_u64()).collect();
    assert!(!marked.is_empty(), "{all}");
    for m in marked {
        let incomplete = m["incomplete"] == json!(true);
        assert_eq!(incomplete, month_start(m["month"].as_str().unwrap()) <= cut, "unknown is not zero: {m}");
    }
}

/// F2: a store that answers with no day and has no ElasticPro template says it was never written.
#[tokio::test]
async fn a_store_never_written_says_so() {
    let dir = TempDir::new("histg-empty");
    let store = h::store(h::fake()).await;
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 30, "avgDays": 3 })).await;
    assert_eq!(daily["history"]["reachable"], json!(true));
    assert_eq!(daily["history"]["templateMissing"], json!(true), "{daily}");
    assert!(daily["history"]["message"].as_str().unwrap().contains("nothing has been written"), "{daily}");
}

/// F7: unreachable says so, never 0; is not asked again for a minute; a display link never waits.
#[tokio::test]
async fn an_unreachable_store_says_so_once_a_minute_and_never_holds_up_a_display() {
    let dir = TempDir::new("histg-down");
    let fs = h::fake();
    fs.lock().unwrap().search_status = Some(503);
    let store = h::store(fs).await;
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 30, "avgDays": 3 })).await;
    assert_eq!(daily["ok"], json!(true), "the local record still answers: {daily}");
    assert_eq!(daily["history"]["reachable"], json!(false), "{daily}");
    assert!(daily["history"]["message"].as_str().unwrap().starts_with("in the history store · not reachable"), "{daily}");
    assert_eq!(daily["days"], json!([]), "no day is made up: {daily}");
    assert_eq!(searches(&store), 1);
    let again = c.handle(json!({ "type": "VOLUME_DAILY", "session": &s, "clusterId": "prod", "days": 30, "avgDays": 3 })).await;
    assert_eq!(again["history"]["reachable"], json!(false));
    assert!(again["history"]["message"].as_str().unwrap().contains("asked again after"), "{again}");
    assert_eq!(searches(&store), 1, "not asked again within the minute");
    // A display link: the wall reads the local record and never waits on the store.
    let wall = Caller { name: "display:noc".into(), role: Role::User, must_change: false, scope: None,
                        play: Some(PlayCaller { link: "noc".into(), clusters: None, allow_from: vec![] }) };
    let shown = c.handle_as(json!({ "type": "VOLUME_DAILY", "clusterId": "prod", "days": 30, "avgDays": 3 }), Some(wall)).await;
    assert_eq!(shown["ok"], json!(true), "{shown}");
    assert_eq!(shown["history"], Value::Null, "{shown}");
    assert_eq!(searches(&store), 1);
    let dead = support::dead_port().await;
    h::configure(&c, &s, &format!("http://127.0.0.1:{dead}")).await;
    let q = c.handle(json!({ "type": "HISTORY_QUERY", "session": &s, "stream": "capacity", "clusterId": "prod" })).await;
    assert_eq!(q["ok"], json!(false));
    assert!(q["message"].as_str().unwrap().contains("not reachable"), "{q}");
}

#[tokio::test]
async fn the_desktop_editions_have_no_store() {
    let dir = TempDir::new("histg-portable");
    let p = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    for t in ["HISTORY_STORE_GET", "HISTORY_STORE_SET", "HISTORY_STORE_TEST", "HISTORY_STORE_ARM", "HISTORY_STORE_BACKFILL", "HISTORY_QUERY"] {
        let res = p.handle(json!({ "type": t, "settings": { "url": "http://x:9200", "auth": "none" }, "on": true })).await;
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
    let store = h::tls_store(h::fake()).await;
    let c = hosted(&dir);
    for t in ["HISTORY_STORE_GET", "HISTORY_STORE_SET", "HISTORY_STORE_TEST", "HISTORY_STORE_ARM", "HISTORY_STORE_BACKFILL", "HISTORY_QUERY"] {
        let res = c.handle(json!({ "type": t })).await;
        assert!(res["kind"] == json!("unauthenticated") || res["kind"] == json!("needs_bootstrap"), "{t}: {res}");
    }
    let s = h::admin(&c).await;
    h::configure_tls(&c, &s, &store).await;
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

/// F11 / F13: an admin limited to some clusters changes neither the store nor the delay
/// schedule, and reads the store and the volume record only for the clusters they see.
#[tokio::test]
async fn a_limited_admin_is_held_to_their_clusters() {
    let dir = TempDir::new("histg-limited");
    let store = h::store(h::fake()).await;
    let prod = h::cluster().await;
    let c = hosted(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;
    h::configure(&c, &s, &store.url()).await;
    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["ES one".into()]), play: None };
    for m in [json!({ "type": "HISTORY_STORE_SET", "settings": h::settings(&store.url(), "none", PREFIX) }),
              json!({ "type": "HISTORY_STORE_ARM", "on": true }),
              json!({ "type": "DELAY_SINK_SET", "config": { "enabled": false, "destination": "history" } }),
              json!({ "type": "HISTORY_QUERY", "stream": "volume", "clusterId": "prod" }),
              json!({ "type": "VOLUME_DAILY", "clusterId": "prod" })] {
        let r = c.handle_as(m.clone(), Some(limited.clone())).await;
        assert_eq!(r["kind"], json!("forbidden"), "{m} -> {r}");
    }
    let read = c.handle_as(json!({ "type": "HISTORY_STORE_GET" }), Some(limited)).await;
    assert_eq!(read["ok"], json!(true), "reading the settings is fine: {read}");
}
