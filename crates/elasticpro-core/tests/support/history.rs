//! A fake history store and a fake monitored cluster for `tests/history_store*.rs`.

#![allow(dead_code)]

use super::tls::{self_signed, TlsServer};
use super::{Hit, TestServer};
use chrono::{Duration, NaiveDate, Utc};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const PASSWORD: &str = "correct-horse-battery";
/// The store's password: every test checks it never comes back out.
pub const STORE_SECRET: &str = "s3cret-store-pa55";
pub const PREFIX: &str = "elasticpro-history";

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

/// What the fake store holds and how it behaves.
#[derive(Default)]
pub struct Fake {
    /// Answered to every volume search (newest first is not simulated: as listed).
    pub docs: Vec<Value>,
    /// The history index template once PUT (or set up front: "already there, ours").
    pub template: Option<Value>,
    /// The other templates PUT (the reports' and the alerts', data_routing.rs), by name.
    pub templates: std::collections::BTreeMap<String, Value>,
    /// A template of the same name that is somebody else's.
    pub foreign: bool,
    /// Every bulk item is refused as malformed.
    pub reject: bool,
    /// Searches answer this many days in all, `READ_BACK_PAGE` per page, one day older per
    /// page, for cluster "prod": to drive the read-back's bound.
    pub paged_total: Option<u64>,
    /// Searches fail with this status.
    pub search_status: Option<u16>,
}

pub type Shared = Arc<Mutex<Fake>>;

pub fn fake() -> Shared {
    Arc::new(Mutex::new(Fake::default()))
}

pub fn fake_with(docs: Vec<Value>) -> Shared {
    Arc::new(Mutex::new(Fake { docs, ..Fake::default() }))
}

/// The page a paged search asks for: 0 without `search_after`, else how many days older than
/// the first page's its `search_after` day is.
fn page_of(body: &Value) -> i64 {
    let first = today() - Duration::days(40);
    body.pointer("/search_after/0").and_then(Value::as_str)
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .map(|d| (first - d).num_days() + 1).unwrap_or(0)
}

pub fn respond(f: &Shared, hit: &Hit) -> (u16, String) {
    let p = hit.path.split('?').next().unwrap_or("");
    let q = hit.path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut f = f.lock().unwrap();
    let missing = |name: &str| (404, json!({ "error": { "type": "resource_not_found_exception", "reason": format!("index template matching [{name}] not found") }, "status": 404 }).to_string());
    match (hit.method.as_str(), p) {
        ("GET", "/") => (200, json!({ "cluster_name": "history", "version": { "number": "8.15.0" } }).to_string()),
        ("POST", "/_security/user/_has_privileges") => {
            let body: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
            let names = body.pointer("/index/0/names/0").and_then(Value::as_str).unwrap_or("").to_string();
            (200, json!({
                "has_all_requested": true, "cluster": { "manage_index_templates": true },
                "index": { names: { "create_doc": true, "create_index": true, "read": true } },
            }).to_string())
        }
        ("PUT", p) if p.starts_with("/_index_template/") => {
            assert_eq!(q, "create=true", "a template is only ever created, never overwritten");
            let name = p.trim_start_matches("/_index_template/").to_string();
            let history = name == format!("{PREFIX}-template");
            let exists = f.foreign || if history { f.template.is_some() } else { f.templates.contains_key(&name) };
            if exists {
                return (400, json!({ "error": { "type": "illegal_argument_exception", "reason": format!("index template [{name}] already exists") }, "status": 400 }).to_string());
            }
            let body: Option<Value> = serde_json::from_str(&hit.body).ok();
            if history {
                f.template = body;
            } else if let Some(b) = body {
                f.templates.insert(name, b);
            }
            (200, r#"{"acknowledged":true}"#.into())
        }
        ("GET", p) if p.starts_with("/_index_template/") => {
            let name = p.trim_start_matches("/_index_template/").to_string();
            if f.foreign {
                return (200, json!({ "index_templates": [{ "name": name, "index_template": { "index_patterns": [format!("{PREFIX}-*")], "template": {} } }] }).to_string());
            }
            let held = if name == format!("{PREFIX}-template") { f.template.clone() } else { f.templates.get(&name).cloned() };
            match held {
                Some(t) => (200, json!({ "index_templates": [{ "name": name, "index_template": t }] }).to_string()),
                None => missing(&name),
            }
        }
        ("POST", "/_bulk") => {
            let n = hit.body.lines().filter(|l| !l.trim().is_empty()).count() / 2;
            let items: Vec<Value> = (0..n).map(|_| if f.reject {
                json!({ "index": { "status": 400, "error": { "type": "mapper_parsing_exception", "reason": "failed to parse" } } })
            } else {
                json!({ "index": { "status": 201 } })
            }).collect();
            (200, json!({ "took": 1, "errors": f.reject, "items": items }).to_string())
        }
        ("POST", p) if p.ends_with("/_search") => {
            if let Some(status) = f.search_status {
                return (status, json!({ "error": { "type": "unavailable", "reason": "the store is down" }, "status": status }).to_string());
            }
            if let Some(total) = f.paged_total {
                let body: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
                let page = page_of(&body);
                let day = dash(today() - Duration::days(40 + page));
                let size = body["size"].as_u64().unwrap_or(10) as usize;
                let hits: Vec<Value> = (0..size).map(|_| json!({
                    "_source": volume_doc_on("prod", &day, 1), "sort": [day, "prod"],
                })).collect();
                return (200, json!({ "hits": { "total": { "value": total }, "hits": hits } }).to_string());
            }
            let hits: Vec<Value> = f.docs.iter().map(|s| json!({ "_source": s, "sort": [s["day"], s["clusterId"]] })).collect();
            (200, json!({ "hits": { "total": { "value": hits.len() }, "hits": hits } }).to_string())
        }
        _ => (400, json!({ "error": { "reason": format!("unexpected {} {}", hit.method, hit.path) } }).to_string()),
    }
}

/// A server that answers every request with a redirect to `to`; returns its port.
pub async fn redirect_to(to: &str) -> u16 {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let to = to.to_string();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let to = to.clone();
            tokio::spawn(async move {
                if super::read_request(&mut sock).await.is_some() {
                    let res = format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {to}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    let _ = sock.write_all(res.as_bytes()).await;
                }
            });
        }
    });
    port
}

/// The store over plain http: no credential may be sent to it (`auth: none`).
pub async fn store(f: Shared) -> TestServer {
    TestServer::with(move |hit| respond(&f, hit)).await
}

/// The store over https with a self-signed certificate (pinned with `trust`).
pub async fn tls_store(f: Shared) -> TlsServer {
    let cert = self_signed("localhost");
    TlsServer::with(&cert, move |hit| respond(&f, hit)).await
}

/// A monitored cluster: one day index (yesterday) for the volume collector, one device for
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

pub fn settings(url: &str, auth: &str, prefix: &str) -> Value {
    json!({ "url": url, "auth": auth, "user": "writer", "password": STORE_SECRET, "tls": "auto", "via": "",
            "prefix": prefix, "streams": { "volume": true, "capacity": true, "delay": true } })
}

/// A plain-http store, no credential.
pub async fn configure(c: &Arc<Core>, s: &str, url: &str) -> Value {
    c.handle(json!({ "type": "HISTORY_STORE_SET", "session": s, "settings": settings(url, "none", PREFIX) })).await
}

/// An https store with a password, its certificate pinned the way an admin does it: the test
/// meets an untrusted certificate, the admin presses Trust, the test passes.
pub async fn configure_tls(c: &Arc<Core>, s: &str, srv: &TlsServer) -> Value {
    let set = c.handle(json!({ "type": "HISTORY_STORE_SET", "session": s, "settings": settings(&srv.url(), "basic", PREFIX) })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    let first = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": s })).await;
    assert_eq!(first["kind"], json!("tls_untrusted"), "a self-signed store is trusted by a person first: {first}");
    let t = c.handle(json!({ "type": "TRUST_CERT", "session": s, "host": srv.host_key() })).await;
    assert_eq!(t["ok"], json!(true), "{t}");
    let test = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": s })).await;
    assert_eq!(test["ok"], json!(true), "{test}");
    test
}

/// Test, then arm.
pub async fn arm(c: &Arc<Core>, s: &str) -> Value {
    let t = c.handle(json!({ "type": "HISTORY_STORE_TEST", "session": s })).await;
    assert_eq!(t["ok"], json!(true), "{t}");
    let a = c.handle(json!({ "type": "HISTORY_STORE_ARM", "session": s, "on": true })).await;
    assert_eq!(a["armed"], json!(true), "{a}");
    a
}

/// Every write the server received: bulks, PUTs, DELETEs.
pub fn writes_of(hits: &[Hit]) -> Vec<String> {
    hits.iter().filter(|h| h.method != "GET" && !h.path.split('?').next().unwrap_or("").ends_with("/_search")
                           && !h.path.starts_with("/_security/user/_has_privileges"))
        .map(|h| format!("{} {}", h.method, h.path)).collect()
}

pub fn writes(srv: &TestServer) -> Vec<String> {
    writes_of(&srv.hits())
}

/// A volume document as the store would hold one.
pub fn volume_doc(cluster: &str, day: NaiveDate, docs: u64) -> Value {
    volume_doc_on(cluster, &dash(day), docs)
}

pub fn volume_doc_on(cluster: &str, day: &str, docs: u64) -> Value {
    json!({ "clusterId": cluster, "clusterName": cluster, "day": day, "final": true, "live": false,
            "indices": 2, "docs": docs, "eventBytes": docs * 3, "subBytes": null, "priBytes": docs * 10, "totalBytes": docs * 20,
            "unmeasuredSizeIndices": 0, "sources": {}, "error": null, "writtenAt": 1 })
}
