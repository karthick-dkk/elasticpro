//! The volume record on hosted with a config file of its own (ELASTICPRO_CONFIG).
//!
//! Its own test binary because ELASTICPRO_CONFIG is process-wide: the other volume tests
//! are about a core without a file.
//!
//!   * a config file that is there but cannot be read or parsed stops collection — the
//!     timer runs nothing and marks nothing, each cluster's `lastError` says why,
//!     `VOLUME_RUN` answers `config_unreadable`, a report job fails — and the first tick
//!     after the file is fixed runs what is due. Built-in settings are only for a core with
//!     no config file at all;
//!   * a hand-written `clusters[]` entry with no `id` gets its own `volume` by the id the UI
//!     primes it under.

mod support;

use chrono::{NaiveDateTime, Utc};
use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{TempDir, TestServer};

const PASSWORD: &str = "correct-horse-battery";

async fn es() -> TestServer {
    TestServer::with(|hit| {
        if hit.path.starts_with("/_cat/indices/") {
            let day = Utc::now().date_naive().format("%Y.%m.%d");
            return (200, json!([{ "index": format!("logstash-linux-{day}"), "status": "open",
                                  "pri.store.size": "10", "store.size": "20" }]).to_string());
        }
        if hit.path.contains("/_field_caps") {
            return (200, json!({ "indices": [], "fields": {
                "fwdtag": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } } } }).to_string());
        }
        if hit.path.contains("/_search") {
            return (200, json!({ "hits": { "total": { "value": 1 } }, "aggregations": {} }).to_string());
        }
        (404, "{}".into())
    })
    .await
}

fn local(hhmm: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(&format!("{} {hhmm}", Utc::now().date_naive().format("%Y-%m-%d")), "%Y-%m-%d %H:%M").unwrap()
}

async fn admin(c: &Arc<Core>) -> String {
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = r["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], true, "{ch}");
    s
}

async fn settle(c: &Arc<Core>, s: &str, id: &str) -> Value {
    for _ in 0..200 {
        let r = c.handle(json!({ "type": "VOLUME_DAILY", "session": s, "clusterId": id })).await;
        if r["status"]["running"] == json!(false) {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the run did not finish");
}

#[tokio::test]
async fn an_unreadable_config_file_stops_collection_until_it_is_fixed() {
    let srv = es().await;
    let dir = TempDir::new("volume-config");
    let path = dir.join("config_cluster.json");
    let good = json!({
        "defaults": { "volume": { "collectAt": "05:00", "topValues": 40 } },
        "clusters": [ { "name": "Prod EU", "url": srv.url(), "volume": { "forwarder": ["fwdtag"] } } ],
    });
    std::fs::write(&path, "{ \"clusters\": [ this is not json").unwrap();
    std::env::set_var("ELASTICPRO_CONFIG", &path);
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    // The id the UI primes a hand-written "Prod EU" entry under.
    let p = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": true, "clusters": [{ "id": "prod-eu", "url": srv.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");

    // The timer: nothing sent, nothing marked, the reason on the cluster.
    let before = srv.connections();
    assert!(c.volume_tick_at(local("23:59")).await.is_empty(), "nothing runs under built-in settings");
    assert_eq!(srv.connections(), before, "nothing reached the cluster");
    let d = c.handle(json!({ "type": "VOLUME_DAILY", "session": s, "clusterId": "prod-eu" })).await;
    assert_eq!(d["ok"], true, "the record is still shown: {d}");
    let e = d["status"]["lastError"].as_str().unwrap_or("");
    assert!(e.starts_with("the config file could not be read:"), "{d}");
    assert_eq!(d["status"]["lastRunAt"], Value::Null);
    assert!(d["configError"].as_str().is_some_and(|x| x.contains("could not be read")), "{d}");
    let state: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("volume").join("prod-eu").join("state.json")).unwrap()).unwrap();
    assert_eq!(state["lastScheduledDay"], Value::Null, "not marked: the next tick tries again");

    // Refresh now and a report job refuse, naming the problem.
    let run = c.handle(json!({ "type": "VOLUME_RUN", "session": s })).await;
    assert_eq!((run["ok"].clone(), run["kind"].clone()), (json!(false), json!("config_unreadable")), "{run}");
    assert!(run["message"].as_str().unwrap().contains("the config file could not be read"), "{run}");
    let check = c.handle(json!({ "type": "VOLUME_FIELDS_CHECK", "session": s, "clusterId": "prod-eu" })).await;
    assert_eq!(check["kind"], "config_unreadable", "{check}");
    let job = c.handle(json!({ "type": "REPORT_RUN", "session": s, "clusterIds": ["prod-eu"], "period": "yesterday", "format": "csvzip" })).await;
    assert_eq!(job["ok"], true, "{job}");
    let id = job["jobs"][0]["id"].as_str().unwrap().to_string();
    let mut ended = Value::Null;
    for _ in 0..200 {
        let j = c.handle(json!({ "type": "REPORT_JOBS", "session": s })).await;
        let me = j["jobs"].as_array().unwrap().iter().find(|x| x["id"] == id.as_str()).cloned().unwrap();
        if me["status"] != "queued" && me["status"] != "running" {
            ended = me;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(ended["status"], "failed", "{ended}");
    assert!(ended["error"].as_str().unwrap_or("").contains("the config file could not be read"), "{ended}");
    assert_eq!(srv.connections(), before, "still nothing reached the cluster");

    // Fixed: the next tick runs, under the file's settings, found by the UI's id.
    std::fs::write(&path, serde_json::to_string_pretty(&good).unwrap()).unwrap();
    let settings = c.handle(json!({ "type": "VOLUME_SETTINGS", "session": s, "clusterId": "prod-eu" })).await;
    assert_eq!(settings["source"], "file", "{settings}");
    assert_eq!(settings["settings"]["forwarder"], json!(["fwdtag"]), "clusters[].volume found without an id: {settings}");
    assert_eq!(settings["overrides"], json!(["prod-eu"]));
    assert!(settings.get("configError").is_none());
    assert_eq!(c.volume_tick_at(local("23:59")).await, vec!["prod-eu".to_string()]);
    let d = settle(&c, &s, "prod-eu").await;
    assert_eq!(d["status"]["lastError"], Value::Null, "{d}");
    assert!(d["status"]["lastRunAt"].is_i64());
    let search = srv.hits().into_iter().find(|h| h.path.contains("/_search")).expect("a search");
    let body: Value = serde_json::from_str(&search.body).unwrap();
    assert_eq!(body["aggs"]["f_forwarder"]["terms"], json!({ "field": "fwdtag", "size": 40 }), "{body}");
    assert!(c.volume_tick_at(local("23:59")).await.is_empty(), "once a day");
}
