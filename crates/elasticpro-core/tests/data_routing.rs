//! Backend routing (docs/HISTORY.md "Backend routing") through the real message API, against
//! a fake history store and a fake monitored cluster on loopback, with config.txt permitting
//! writes (`HISTORY_STORE_WRITES=true`; its own binary, config.txt is loaded once per process).
//!
//! What these prove:
//!
//!   * built-in is the default for every kind, and in it nothing is queued for the store;
//!   * "Elasticsearch only" with the store not writing (no store, not armed) keeps the built-in
//!     record and queues the record; the status says so; once the store is armed the queue goes
//!     out — into `<prefix>-alerts-YYYY` / `<prefix>-reports-YYYY`, each after its own template;
//!   * acknowledgements, silences, a page's raised/cleared (deduplicated, on visible clusters
//!     only) and a report job's end are the records; nothing is ever written to the monitored
//!     cluster, even with `readOnly: false`;
//!   * a copy does not queue while the gates are closed; history routed built-in refuses the
//!     delay sink's store destination; the messages are an admin's, a limited admin may read
//!     but not change; the desktop has none of it.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::settings::{self, Settings};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::history::{self as h, PREFIX};
use support::TempDir;

fn core(dir: &TempDir) -> Arc<Core> {
    settings::init_with(Settings::parse("HISTORY_STORE_WRITES=true\n"));
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

async fn status(c: &Arc<Core>, s: &str) -> Value {
    c.handle(json!({ "type": "DATA_ROUTING_STATUS", "session": s })).await
}

async fn route(c: &Arc<Core>, s: &str, routing: Value) -> Value {
    c.handle(json!({ "type": "DATA_ROUTING_SET", "session": s, "routing": routing })).await
}

async fn ended(c: &Arc<Core>, s: &str, id: &str) -> Value {
    for _ in 0..400 {
        let r = c.handle(json!({ "type": "REPORT_JOBS", "session": s })).await;
        if let Some(j) = r["jobs"].as_array().and_then(|a| a.iter().find(|j| j["id"] == id)) {
            if !matches!(j["status"].as_str(), Some("queued" | "running")) {
                return j.clone();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("job {id} did not end");
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

fn bulks(store: &support::TestServer) -> Vec<String> {
    store.hits().into_iter().filter(|x| x.path == "/_bulk").map(|x| x.body).collect()
}

#[tokio::test]
async fn es_only_keeps_the_builtin_record_queues_while_the_store_is_not_writing_and_sends_once_it_is() {
    let dir = TempDir::new("routing-es");
    let store = h::store(h::fake()).await;
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    // readOnly false: the monitored cluster's own switch is open, and still nothing here writes to it.
    h::prime(&c, &s, &prod.url(), false).await;

    let ping = c.handle(json!({ "type": "PING", "session": &s })).await;
    assert_eq!(ping["dataRouting"]["supported"], json!(true), "{ping}");
    let g = c.handle(json!({ "type": "DATA_ROUTING_GET", "session": &s })).await;
    assert_eq!(g["ok"], json!(true), "{g}");
    assert_eq!((&g["routing"]["history"], &g["routing"]["reports"], &g["routing"]["alerts"]), (&json!("builtin"), &json!("builtin"), &json!("builtin")),
               "built-in is the default for everything: {g}");
    assert_eq!(g["store"]["configured"], json!(false));

    // Built-in: a silence is kept on the server and nothing is queued for a store.
    let sil = c.handle(json!({ "type": "SILENCE_SET", "session": &s, "scope": "cluster", "target": "prod", "minutes": 30, "reason": "patching" })).await;
    assert_eq!(sil["ok"], json!(true), "{sil}");
    let st = status(&c, &s).await;
    assert_eq!(st["kinds"]["alerts"]["state"], json!("builtin"), "{st}");
    assert_eq!(st["kinds"]["alerts"]["store"]["queued"], json!(0));
    assert_eq!(st["kinds"]["alerts"]["store"]["docs"], Value::Null, "unknown, not 0: {st}");
    assert!(st["builtin"]["size"]["bytes"].is_u64(), "the data directory's size: {st}");
    assert!(st["builtin"]["diskFree"].is_u64() || st["builtin"]["diskFree"].is_null(), "{st}");
    assert!(st["kinds"]["history"]["keptFor"]["builtin"].as_str().unwrap().contains("months"), "{st}");
    assert_eq!(st["kinds"]["history"]["keptFor"]["store"], json!("the store owner's ILM"));

    // Elasticsearch only, with no store at all: the built-in record is written and the record waits.
    let set = route(&c, &s, json!({ "alerts": "es", "reports": "es" })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["routing"]["alerts"], json!("es"));
    assert_eq!(set["routing"]["changedBy"], json!("Admin"));
    let id = sil["silence"]["id"].as_str().unwrap().to_string();
    let clear = c.handle(json!({ "type": "SILENCE_CLEAR", "session": &s, "id": id })).await;
    assert_eq!(clear["ok"], json!(true), "{clear}");
    let on_disk = std::fs::read_to_string(dir.join("silences.json")).expect("the built-in record is still written");
    assert!(on_disk.starts_with('['), "{on_disk}");
    let st = status(&c, &s).await;
    assert_eq!(st["kinds"]["alerts"]["state"], json!("queued"), "{st}");
    assert_eq!(st["kinds"]["alerts"]["store"]["queued"], json!(1), "{st}");
    let line = st["kinds"]["alerts"]["line"].as_str().unwrap();
    assert!(line.contains("kept in the built-in store meanwhile") && line.contains("1 queued"), "{line}");
    assert!(st["kinds"]["alerts"]["store"]["why"].as_str().unwrap().contains("Write history is off"), "the first closed gate, by name: {st}");
    assert!(st["kinds"]["alerts"]["store"]["docsNote"].as_str().unwrap().contains("no Elasticsearch store"), "{st}");
    let tick = c.history_tick().await;
    assert!(tick["skipped"].is_string(), "{tick}");
    assert_eq!(tick["queue"], json!(1), "a closed gate keeps the queue: {tick}");

    // A report job ends: its record is spooled (the worker may be another process), and the
    // next tick queues it.
    let r = c.handle(json!({ "type": "REPORT_RUN", "session": &s, "clusterIds": ["prod"], "period": "last7", "format": "csvzip" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let job_id = r["jobs"][0]["id"].as_str().or_else(|| r["ids"][0].as_str()).or_else(|| r["id"].as_str()).unwrap_or_else(|| panic!("{r}")).to_string();
    let job = ended(&c, &s, &job_id).await;
    assert_eq!(job["status"], json!("done"), "{job}");
    let spool = dir.join("history-store-spool");
    wait_for("the report record to be spooled", || std::fs::read_dir(&spool).map(|d| d.count() > 0).unwrap_or(false)).await;
    c.history_tick().await;
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0, "the tick drains the spool");
    let st = status(&c, &s).await;
    assert_eq!(st["kinds"]["reports"]["store"]["queued"], json!(1), "{st}");
    assert!(st["kinds"]["reports"]["builtin"]["size"]["bytes"].as_u64().unwrap() > 0, "the report file is on disk: {st}");

    // The store arrives, is tested and armed: the queue goes out, each stream after its own template.
    h::configure(&c, &s, &store.url()).await;
    h::arm(&c, &s).await;
    let tick = c.history_tick().await;
    assert_eq!(tick["ok"], json!(true), "{tick}");
    assert_eq!(tick["written"], json!(2), "{tick}");
    let order: Vec<String> = store.hits().into_iter().filter(|x| x.method != "GET").map(|x| format!("{} {}", x.method, x.path)).collect();
    let pos = |needle: &str| order.iter().position(|o| o.contains(needle)).unwrap_or_else(|| panic!("{needle} in {order:?}"));
    assert!(pos(&format!("PUT /_index_template/{PREFIX}-alerts-template?create=true")) < pos("POST /_bulk"), "{order:?}");
    assert!(order.iter().any(|o| o.starts_with(&format!("PUT /_index_template/{PREFIX}-reports-template?create=true"))), "{order:?}");
    assert!(!order.iter().any(|o| o.starts_with(&format!("PUT /_index_template/{PREFIX}-template?"))), "no history document, no history template: {order:?}");
    let all = bulks(&store).concat();
    let year = h::today().format("%Y").to_string();
    assert!(all.contains(&format!(r#""_index":"{PREFIX}-alerts-{year}""#)), "{all}");
    assert!(all.contains(r#""_id":"unsilenced|prod|"#) && all.contains(r#""event":"unsilenced""#) && all.contains(r#""scope":"cluster""#), "{all}");
    assert!(all.contains(&format!(r#""_index":"{PREFIX}-reports-{year}""#)), "{all}");
    assert!(all.contains(&format!(r#""jobId":"{job_id}""#)) && all.contains(r#""report":"volume""#) && all.contains(r#""status":"done""#), "{all}");
    assert!(all.contains(r#""rows":null"#), "a volume report counts days, not rows: {all}");
    assert!(!all.contains("fileContent"), "the file is carried only when asked");
    let templates: Vec<String> = store.hits().into_iter().filter(|x| x.method == "PUT").map(|x| x.body).collect();
    for t in &templates {
        assert!(!t.contains("settings") && !t.contains("lifecycle"), "mappings only: {t}");
        assert!(t.contains(r#""dynamic":false"#), "{t}");
    }

    // Acknowledgements and a page's raised/cleared are records too.
    let ack = c.handle(json!({ "type": "ACK_SET", "session": &s, "key": "prod:disk", "note": "vendor called" })).await;
    assert_eq!(ack["ok"], json!(true), "{ack}");
    let put = c.handle(json!({ "type": "ALERT_EVENTS_PUT", "session": &s, "events": [
        { "event": "raised", "key": "prod:disk", "rule": "disk", "level": "crit", "approx": true },
        { "event": "raised", "key": "prod:disk" },
        { "event": "raised", "key": "nope:disk" },
    ] })).await;
    assert_eq!((&put["accepted"], &put["dropped"], &put["unknown"]), (&json!(1), &json!(1), &json!(1)), "{put}");
    let tick = c.history_tick().await;
    assert_eq!(tick["written"], json!(2), "{tick}");
    let all = bulks(&store).concat();
    assert!(all.contains(r#""_id":"acknowledged|prod:disk|"#) && all.contains(r#""note":"vendor called""#), "{all}");
    assert!(all.contains(r#""_id":"raised|prod:disk|"#) && all.contains(r#""reportedBy":"Admin""#) && all.contains(r#""approx":true"#), "{all}");
    assert!(!all.contains("nope:disk"), "a key naming no cluster is never written");

    let st = status(&c, &s).await;
    assert_eq!(st["kinds"]["alerts"]["state"], json!("writing"), "{st}");
    assert_eq!(st["kinds"]["alerts"]["store"]["queued"], json!(0));
    assert_eq!(st["kinds"]["alerts"]["store"]["docs"], json!(0), "the fake store answers its count: {st}");
    assert!(st["kinds"]["reports"]["store"]["docs"].is_u64(), "{st}");
    assert_eq!(st["kinds"]["history"]["store"]["docs"], Value::Null, "not asked for a kind kept built-in: {st}");

    // The monitored cluster: searched by the report, never written.
    assert!(h::writes(&prod).is_empty(), "the monitored cluster is never written: {:?}", h::writes(&prod));
}

#[tokio::test]
async fn a_copy_does_not_queue_while_the_gates_are_closed_and_roles_hold() {
    let dir = TempDir::new("routing-copy");
    let prod = h::cluster().await;
    let c = core(&dir);
    let s = h::admin(&c).await;
    h::prime(&c, &s, &prod.url(), true).await;

    let set = route(&c, &s, json!({ "alerts": "copy", "reportFiles": true })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["routing"]["reportFiles"], json!(true));
    let sil = c.handle(json!({ "type": "SILENCE_SET", "session": &s, "scope": "alert", "target": "prod:disk", "minutes": 5, "reason": "x" })).await;
    assert_eq!(sil["ok"], json!(true), "{sil}");
    let st = status(&c, &s).await;
    assert_eq!(st["kinds"]["alerts"]["state"], json!("paused"), "{st}");
    assert_eq!(st["kinds"]["alerts"]["store"]["queued"], json!(0), "a copy is not a backlog: {st}");
    assert!(st["kinds"]["alerts"]["line"].as_str().unwrap().contains("not copying"), "{st}");

    // History kept built-in: the delay sink may not point at the store.
    let d = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": true, "destination": "history", "everyHours": 2 } })).await;
    assert_eq!(d["ok"], json!(true), "{d}");
    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert!(run["skipped"].as_str().unwrap_or("").contains("history store"), "{run}");

    // What is not a mode, or not a field, is refused by name.
    let bad = route(&c, &s, json!({ "alerts": "cluster" })).await;
    assert_eq!(bad["kind"], json!("bad_request"), "{bad}");
    assert!(bad["message"].as_str().unwrap().contains("not builtin, copy or es"));
    assert_eq!(route(&c, &s, json!({ "monitored": "es" })).await["kind"], json!("bad_request"));
    let kept = c.handle(json!({ "type": "DATA_ROUTING_GET", "session": &s })).await;
    assert_eq!(kept["routing"]["alerts"], json!("copy"), "a refused change changes nothing: {kept}");

    // A limited admin reads the routing and its status, and changes nothing.
    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["ES one".into()]), play: None };
    let r = c.handle_as(json!({ "type": "DATA_ROUTING_SET", "routing": { "alerts": "es" } }), Some(limited.clone())).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");
    let r = c.handle_as(json!({ "type": "DATA_ROUTING_GET" }), Some(limited.clone())).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = c.handle_as(json!({ "type": "DATA_ROUTING_STATUS" }), Some(limited)).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    // A user: none of the three; a page's events, on the clusters they see only.
    for role in ["user", "operator"] {
        let add = c.handle(json!({ "type": "USER_ADD", "session": &s, "name": role, "password": h::PASSWORD, "role": role })).await;
        assert_eq!(add["ok"], json!(true), "{add}");
    }
    let user = c.handle(json!({ "type": "LOGIN", "name": "user", "password": h::PASSWORD })).await["session"].as_str().unwrap().to_string();
    for t in ["DATA_ROUTING_GET", "DATA_ROUTING_SET", "DATA_ROUTING_STATUS"] {
        let r = c.handle(json!({ "type": t, "session": &user, "routing": { "alerts": "es" } })).await;
        assert_eq!(r["kind"], json!("forbidden"), "{t}: {r}");
    }
    let put = c.handle(json!({ "type": "ALERT_EVENTS_PUT", "session": &user, "events": [{ "event": "cleared", "key": "prod:disk" }] })).await;
    assert_eq!(put["ok"], json!(true), "{put}");
    assert_eq!(put["accepted"], json!(1));
    let scoped = Caller { name: "ops@zabbix".into(), role: Role::User, must_change: false, scope: Some(vec!["Team B".into()]), play: None };
    let r = c.handle_as(json!({ "type": "ALERT_EVENTS_PUT", "events": [{ "event": "raised", "key": "prod:disk" }] }), Some(scoped)).await;
    assert_eq!(r["kind"], json!("forbidden"), "a cluster they cannot see: {r}");
    let bad = c.handle(json!({ "type": "ALERT_EVENTS_PUT", "session": &user, "events": [{ "event": "acknowledged", "key": "prod:disk" }] })).await;
    assert_eq!(bad["kind"], json!("bad_request"), "a page reports only what it sees: {bad}");
    assert!(h::writes(&prod).is_empty(), "{:?}", h::writes(&prod));
}

#[tokio::test]
async fn the_desktop_routes_nothing() {
    let dir = TempDir::new("routing-desktop");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["dataRouting"]["supported"], json!(false), "{ping}");
    let g = c.handle(json!({ "type": "DATA_ROUTING_GET" })).await;
    assert_eq!((&g["ok"], &g["supported"]), (&json!(false), &json!(false)), "{g}");
    let put = c.handle(json!({ "type": "ALERT_EVENTS_PUT", "events": [{ "event": "raised", "key": "x:y" }] })).await;
    assert_eq!((&put["ok"], &put["supported"], &put["accepted"]), (&json!(true), &json!(false), &json!(0)), "{put}");
}
