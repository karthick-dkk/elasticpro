//! A fake history store and a fake monitored cluster for `tests/history_store*.rs`.

#![allow(dead_code)]

use super::TestServer;
use chrono::{Duration, NaiveDate, Utc};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const PASSWORD: &str = "correct-horse-battery";
/// The store's password: every test checks it never comes back out.
pub const STORE_SECRET: &str = "s3cret-store-pa55";

pub fn today() -> NaiveDate {
    Utc::now().date_naive()
}
pub fn dash(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}
pub fn dot(d: NaiveDate) -> String {
    d.format("%Y.%m.%d").to_string()
}
pub fn yesterday() -> NaiveDate {
    today() - Duration::days(1)
}
/// Late today, local time: past any `collectAt`, so the daily run is due.
pub fn local_late() -> chrono::NaiveDateTime {
    chrono::Local::now().date_naive().and_hms_opt(23, 59, 0).expect("a time")
}

/// A store that answers the test, the template and bulks, and returns `docs` to any search.
pub async fn store(docs: Arc<Mutex<Vec<Value>>>) -> TestServer {
    TestServer::with(move |hit| {
        let p = hit.path.split('?').next().unwrap_or("");
        match (hit.method.as_str(), p) {
            ("GET", "/") => (200, json!({ "cluster_name": "history", "version": { "number": "8.15.0" } }).to_string()),
            ("POST", "/_security/user/_has_privileges") => (200, json!({
                "has_all_requested": true, "cluster": { "manage_index_templates": true },
                "index": { "elasticpro-history-*": { "create_doc": true, "create_index": true, "read": true } },
            }).to_string()),
            ("PUT", p) if p.starts_with("/_index_template/") => (200, r#"{"acknowledged":true}"#.into()),
            ("POST", "/_bulk") => {
                let n = hit.body.lines().filter(|l| !l.trim().is_empty()).count() / 2;
                let items: Vec<Value> = (0..n).map(|_| json!({ "index": { "status": 201 } })).collect();
                (200, json!({ "took": 1, "errors": false, "items": items }).to_string())
            }
            ("POST", p) if p.ends_with("/_search") => {
                let d = docs.lock().unwrap().clone();
                let hits: Vec<Value> = d.iter().map(|s| json!({ "_source": s })).collect();
                (200, json!({ "hits": { "total": { "value": hits.len() }, "hits": hits } }).to_string())
            }
            _ => (400, json!({ "error": { "reason": format!("unexpected {} {}", hit.method, hit.path) } }).to_string()),
        }
    })
    .await
}

/// A monitored cluster: one day index (yesterday) for the volume collector, two devices for
/// the delay measurement. It accepts a write only so that a test can prove none arrived.
pub async fn cluster() -> TestServer {
    let index = format!("logstash-linux-{}", dot(yesterday()));
    TestServer::with(move |hit| {
        if hit.path.starts_with("/_cat/indices/") {
            return (200, json!([{ "index": index, "status": "open", "docs.count": "100", "pri.store.size": "1000", "store.size": "2000" }]).to_string());
        }
        if hit.path.contains("/_field_caps") {
            return (200, json!({ "indices": [], "fields": {
                "event_logsize": { "long": { "type": "long", "searchable": true, "aggregatable": true } },
                "@timestamp": { "date": { "type": "date", "searchable": true, "aggregatable": true } },
            } }).to_string());
        }
        if hit.path.contains("/_search") && hit.body.contains("\"devices\"") {
            return (200, json!({ "aggregations": { "devices": { "buckets": [
                { "key": "fw-1", "doc_count": 120, "latest": { "hits": { "hits": [
                    { "_source": { "@timestamp": "2026-09-19T12:41:00Z", "ingested_time": "2026-09-19T12:00:00Z" } } ] } } },
            ] } } }).to_string());
        }
        if hit.path.contains("/_search") {
            return (200, json!({ "hits": { "total": { "value": 100, "relation": "eq" } }, "aggregations": {
                "ev": { "value": 300.0 },
                "by_index": { "sum_other_doc_count": 0, "buckets": [{ "key": index, "doc_count": 100, "ev": { "value": 300.0 } }] },
            } }).to_string());
        }
        (200, r#"{"acknowledged":true,"errors":false,"items":[]}"#.into())
    })
    .await
}

pub async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": &s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

pub async fn prime(c: &Arc<Core>, s: &str, url: &str, read_only: bool) {
    let res = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": read_only, "clusters": [{ "id": "prod", "url": url }] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
}

pub async fn configure(c: &Arc<Core>, s: &str, url: &str) -> Value {
    c.handle(json!({ "type": "HISTORY_STORE_SET", "session": s, "settings": {
        "url": url, "auth": "basic", "user": "writer", "password": STORE_SECRET, "tls": "auto", "via": "",
        "prefix": "elasticpro-history", "streams": { "volume": true, "capacity": true, "delay": true },
    } })).await
}

/// Every write the server received: bulks, PUTs, DELETEs.
pub fn writes(srv: &TestServer) -> Vec<String> {
    srv.hits().iter().filter(|h| h.method != "GET" && !h.path.split('?').next().unwrap_or("").ends_with("/_search")
                                 && !h.path.starts_with("/_security/user/_has_privileges"))
        .map(|h| format!("{} {}", h.method, h.path)).collect()
}

/// A volume document as the store would hold one.
pub fn volume_doc(cluster: &str, day: NaiveDate, docs: u64) -> Value {
    json!({ "clusterId": cluster, "clusterName": cluster, "day": dash(day), "final": true, "live": false,
            "indices": 2, "docs": docs, "eventBytes": docs * 3, "subBytes": null, "priBytes": docs * 10, "totalBytes": docs * 20,
            "unmeasuredSizeIndices": 0, "sources": {}, "error": null, "writtenAt": 1 })
}
