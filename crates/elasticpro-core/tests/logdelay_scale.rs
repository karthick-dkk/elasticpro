//! The log delay measurement at scale (docs/LOGDELAY.md "Measurement", "Fetch now"): a
//! cluster of 25 000 devices, read in composite pages through *Fetch now*
//! (`JOB_RUN {jobId: "logdelay.measure", clusterIds: [one], devices: late|all, device?}`), with
//! nothing cut.
//!
//!   * every device is read: 25 000 in, 25 000 in the store, the states counted as generated;
//!   * no page asks for more than 1000 devices and no answer is larger than a page of them —
//!     the run never holds the fleet's answer, only its readings;
//!   * *Max devices per run* above 20 000 is a setting, and reaching it is said, without
//!     turning the devices it did not read silent;
//!   * a run scoped to one device reads that device only and changes nobody else;
//!   * the run log shows the progress and the devices measured;
//!   * with log types (25 000 devices × 3) the pages are of at most 500, the counts are as generated,
//!     and the memory and the state file stay inside the core's 1 GB limit. The full history (31 days
//!     of devices, 8 of log types) is the ignored test: `cargo test --release --test logdelay_scale --
//!     --ignored --nocapture` prints its figures.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use support::{TempDir, TestServer};

const PASSWORD: &str = "correct-horse-battery";
const DEVICES: usize = 25_000;

/// Device `i` (1-based), as tools/mock-es.mjs MOCK_LD_DEVICES makes it: minutes late, or
/// `None` for no event time.
fn minutes(i: usize) -> Option<f64> {
    if i.is_multiple_of(97) { Some(-37.0) } else if i.is_multiple_of(50) { Some(95.0) } else if i.is_multiple_of(20) { Some(41.0) } else if i.is_multiple_of(33) { None } else { Some((i % 7) as f64) }
}

fn name(i: usize) -> String {
    format!("dev-{i:06}")
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[derive(Default)]
struct Seen {
    pages: AtomicUsize,
    largest_ask: AtomicUsize,
    largest_answer: AtomicUsize,
}

/// One composite page of the generated fleet, as Elasticsearch answers it.
fn page(body: &Value, seen: &Seen) -> String {
    let comp = &body["aggs"]["devices"]["composite"];
    assert!(body["aggs"]["devices"].get("terms").is_none(), "a terms size is a cap: {body}");
    let size = comp["size"].as_u64().unwrap() as usize;
    seen.largest_ask.fetch_max(size, Ordering::SeqCst);
    let after = comp["after"]["d"].as_str().map(String::from);
    let filters = body["query"]["bool"]["filter"].as_array().unwrap();
    let only = filters.iter().find_map(|f| f["term"].as_object().and_then(|m| m.values().next()).and_then(Value::as_str).map(String::from));
    // A `terms` filter (the late devices): those names, in name order, paged like the rest.
    let named: Option<Vec<usize>> = filters.iter().find_map(|f| f["terms"].as_object().and_then(|m| m.values().next()).and_then(Value::as_array))
        .map(|a| { let mut v: Vec<usize> = a.iter().filter_map(Value::as_str).map(|d| d.trim_start_matches("dev-").parse().unwrap()).collect(); v.sort(); v });
    let start = after.as_deref().map(|a| a.trim_start_matches("dev-").parse::<usize>().unwrap() + 1).unwrap_or(1);
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<usize> = match (&only, &named) {
        (Some(d), _) => vec![d.trim_start_matches("dev-").parse().unwrap()],
        (None, Some(list)) => list.iter().copied().filter(|i| *i >= start).take(size).collect(),
        (None, None) => (start..=DEVICES).take(size).collect(),
    };
    let buckets: Vec<Value> = ids.iter().map(|&i| {
        let arrival = now - 60_000;
        let tag1 = ["firewall", "proxy", "switch"][i % 3];
        let mut src = json!({ "@timestamp": iso(arrival), "Zone": format!("dc{}", i % 4 + 1), "tag1": tag1 });
        if let Some(m) = minutes(i) {
            // Half the fleet carries one event-time field, half the other: both are read.
            src[if i % 2 == 1 { "event_created" } else { "ingested_time" }] = json!(iso(arrival - (m * 60_000.0) as i64));
        }
        json!({ "key": { "d": name(i) }, "doc_count": 10 + i % 90, "latest": { "hits": { "hits": [ { "_source": src } ] } } })
    }).collect();
    let mut devices = json!({ "buckets": buckets });
    if let Some(&last) = ids.last() {
        devices["after_key"] = json!({ "d": name(last) });
    }
    let mut aggs = json!({ "devices": devices });
    if body["aggs"].get("no_device").is_some() {
        aggs["no_device"] = json!({ "doc_count": 3 });
    }
    let text = json!({ "took": 7, "timed_out": false, "_shards": { "total": 1, "successful": 1, "failed": 0 }, "aggregations": aggs }).to_string();
    seen.pages.fetch_add(1, Ordering::SeqCst);
    seen.largest_answer.fetch_max(text.len(), Ordering::SeqCst);
    text
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": &s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn ended_run(c: &Arc<Core>, s: &str, id: &str) -> Value {
    for _ in 0..2400 {
        let l = c.handle(json!({ "type": "JOBS_LIST", "session": s, "jobId": "logdelay.measure", "limit": 200 })).await;
        if let Some(r) = l["runs"].as_array().unwrap().iter().find(|r| r["id"] == json!(id)) {
            if !matches!(r["status"].as_str(), Some("running" | "queued")) {
                return r.clone();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("run {id} did not end");
}

async fn fetch_now(c: &Arc<Core>, s: &str, extra: Value) -> Value {
    let mut m = json!({ "type": "JOB_RUN", "session": s, "jobId": "logdelay.measure" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    let r = c.handle(m).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    ended_run(c, s, r["runId"].as_str().unwrap()).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn twenty_five_thousand_devices_are_read_in_pages_and_nothing_is_cut() {
    let dir = TempDir::new("logdelay-scale");
    let seen = Arc::new(Seen::default());
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (s2, b2) = (seen.clone(), bodies.clone());
    let srv = TestServer::with(move |hit| {
        if hit.path.contains("/_search") {
            let body: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
            b2.lock().unwrap().push(body.clone());
            return (200, page(&body, &s2));
        }
        (200, r#"{"cluster_name":"big","status":"green"}"#.into())
    }).await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    let p = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": srv.url() }] })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    // Max devices per run above 20 000: accepted as it is (not clamped to 10 000 as before).
    let set = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": false, "destination": "builtin", "everyHours": 2, "maxDevices": 30000 } })).await;
    assert_eq!(set["config"]["maxDevices"], json!(30000), "{set}");

    // Fetch now is one cluster: without it, or with two, it is refused before anything runs.
    for bad in [json!({}), json!({ "clusterIds": [] }), json!({ "clusterIds": ["prod", "prod"] }), json!({ "clusterIds": ["prod"], "devices": "some" })] {
        let mut m = json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" });
        for (k, v) in bad.as_object().unwrap() { m[k] = v.clone(); }
        let r = c.handle(m).await;
        assert_eq!(r["kind"], json!("bad_request"), "{bad}: {r}");
    }
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    assert_eq!(run["status"], json!("completed"), "{run}");
    assert_eq!(run["records"], json!(DEVICES), "every device measured: {run}");
    assert_eq!((run["done"].clone(), run["total"].clone(), run["progress"].clone()), (json!(DEVICES), json!(DEVICES), json!(100)), "a one-cluster run counts devices: {run}");
    assert!(run["note"].as_str().unwrap().contains("whole cluster"), "{run}");
    assert_eq!(run["scope"]["devices"], json!("all"));
    let pages = seen.pages.load(Ordering::SeqCst);
    assert_eq!(pages, 26, "25 full pages of 1000 and the empty one that ends the list");
    assert!(seen.largest_ask.load(Ordering::SeqCst) <= 1000, "no page asks for more than 1000 devices");
    let largest = seen.largest_answer.load(Ordering::SeqCst);
    assert!(largest < 512 * 1024, "one page's answer is a page, not the fleet: {largest} bytes");
    // Every page reads the same window: absolute instants, not "now-2h" moving under the run.
    let windows: std::collections::HashSet<String> = bodies.lock().unwrap().iter().map(|b| b["query"]["bool"]["filter"][0].to_string()).collect();
    assert_eq!(windows.len(), 1, "{windows:?}");

    // What the store holds is what was generated, counted the one way (levels.rs).
    let want = |f: &dyn Fn(Option<f64>) -> bool| (1..=DEVICES).filter(|&i| f(minutes(i))).count();
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 1 })).await;
    let t = &sum["totals"];
    assert_eq!(t["devices"], json!(DEVICES), "{t}");
    assert_eq!(t["critical"], json!(want(&|m| m == Some(95.0))));
    assert_eq!(t["delay"], json!(want(&|m| m == Some(41.0))));
    assert_eq!(t["clockAhead"], json!(want(&|m| m == Some(-37.0))));
    assert_eq!(t["unmeasured"], json!(want(&|m| m.is_none())), "no event time: can't measure, never error-as-zero");
    assert_eq!(t["silent"], json!(0));
    assert_eq!(sum["devicesTruncated"], json!(true), "the answer's list is cut at maxDevices 1, and says so");
    assert_eq!(sum["devicesInLastRun"], json!(DEVICES));
    let bc = &sum["byCluster"][0];
    assert_eq!((bc["counts"]["inLastRun"].clone(), bc["counts"]["inRange"].clone(), bc["counts"]["now"].clone()), (json!(DEVICES), json!(DEVICES), json!(DEVICES)), "{bc}");
    let read = &bc["lastRead"];
    assert_eq!((read["devices"].clone(), read["pages"].clone(), read["complete"].clone(), read["truncated"].clone(), read["noDevice"].clone()),
               (json!(DEVICES), json!(26), json!(true), json!(false), json!(3)), "{read}");
    // Zone and tag1 on every row.
    let one = c.handle(json!({ "type": "LOGDELAY_SEARCH", "session": &s, "name": "dev-000020" })).await;
    let row = &one["devices"][0];
    assert_eq!((row["zone"].clone(), row["tag1"].clone(), row["state"].clone()), (json!("dc1"), json!("switch"), json!("delay")), "{row}");

    // The late devices alone (the default): those delayed or critical at the start by the levels —
    // the 41- and 95-minute ones (30 and over) — in one terms filter; nobody else is read, nobody
    // is turned silent, and the cluster's own last run stays the whole run's.
    let late_n = want(&|m| m.is_some_and(|x| x >= 30.0));
    let before = seen.pages.load(Ordering::SeqCst);
    let cl_before = c.handle(json!({ "type": "LOGDELAY_CLUSTER", "session": &s, "clusterId": "prod" })).await;
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"] })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(late_n)), "{run}");
    assert_eq!((run["done"].clone(), run["total"].clone()), (json!(late_n), json!(late_n)), "{run}");
    assert!(run["note"].as_str().unwrap().contains(&format!("late devices ({late_n} of {DEVICES}")), "{run}");
    assert_eq!(run["scope"]["devices"], json!("late"));
    let last = bodies.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last["query"]["bool"]["filter"][1]["terms"]["src_hostname.keyword"].as_array().unwrap().len(), late_n, "{last}");
    assert!(seen.pages.load(Ordering::SeqCst) - before <= 3, "a terms filter, pages of 1000");
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 1 })).await;
    assert_eq!((sum["totals"]["devices"].clone(), sum["totals"]["silent"].clone()), (json!(DEVICES), json!(0)), "nobody turned silent by a late-devices run");
    let cl = c.handle(json!({ "type": "LOGDELAY_CLUSTER", "session": &s, "clusterId": "prod" })).await;
    assert_eq!(cl["lastRunAt"], cl_before["lastRunAt"], "the cluster's last run is still the whole run");
    assert_eq!(cl["lastRead"]["devices"], json!(DEVICES), "{}", cl["lastRead"]);

    // A device scoped run: that device alone, nobody else touched.
    let before = seen.pages.load(Ordering::SeqCst);
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "device": "dev-000020" })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(1)), "{run}");
    assert!(run["note"].as_str().unwrap().contains("device dev-000020"), "{run}");
    assert_eq!(seen.pages.load(Ordering::SeqCst) - before, 1);
    let last = bodies.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last["query"]["bool"]["filter"][1]["term"]["src_hostname.keyword"], json!("dev-000020"), "{last}");
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 1 })).await;
    assert_eq!((sum["totals"]["devices"].clone(), sum["totals"]["silent"].clone()), (json!(DEVICES), json!(0)), "nobody turned silent by a one-device run");
    // A retry of it is the same scope.
    let bad = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure", "device": "dev-*" })).await;
    assert_eq!(bad["kind"], json!("bad_request"), "{bad}");
    let none = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure", "clusterIds": ["nope"] })).await;
    assert_eq!(none["kind"], json!("not_found"), "{none}");

    // Max devices per run reached: the first 20 500 by name read, the run says the rest was not,
    // and the 4500 it did not read are not turned silent (unknown is not "no logs").
    let set = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": false, "destination": "builtin", "everyHours": 2, "maxDevices": 20500 } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(20_500)), "{run}");
    assert!(run["note"].as_str().unwrap().contains("Max devices per run"), "{run}");
    let cl = c.handle(json!({ "type": "LOGDELAY_CLUSTER", "session": &s, "clusterId": "prod" })).await;
    assert_eq!((cl["lastRead"]["devices"].clone(), cl["lastRead"]["truncated"].clone(), cl["lastRead"]["maxDevices"].clone()), (json!(20_500), json!(true), json!(20_500)), "{}", cl["lastRead"]);
    assert_eq!(cl["totals"]["silent"], json!(0), "{}", cl["totals"]);
    assert_eq!(cl["counts"]["inLastRun"], json!(20_500));
}

/* ------------------------------------ log types ------------------------------------ */

const TYPES: [&str; 3] = ["traffic", "threat", "system"];

/// Log type `k` of device `i`: every 10th device's threat is 46 min late, every 50th device is late
/// with every type, every 40th has no threat logs.
fn type_minutes(i: usize, k: usize) -> Option<f64> {
    match (i, k) {
        (i, _) if i.is_multiple_of(50) => Some(95.0),
        (i, 1) if i.is_multiple_of(40) => None,
        (i, 1) if i.is_multiple_of(10) => Some(46.0),
        _ => Some((i % 7) as f64),
    }
}

/// One page as Elasticsearch answers it with the types in it.
fn typed_page(body: &Value, seen: &Seen) -> String {
    let comp = &body["aggs"]["devices"]["composite"];
    let size = comp["size"].as_u64().unwrap() as usize;
    seen.largest_ask.fetch_max(size, Ordering::SeqCst);
    let each = &body["aggs"]["devices"]["aggs"];
    assert_eq!(each["types"]["terms"]["field"], json!("log_type.keyword"), "the types are in the same search: {body}");
    let start = comp["after"]["d"].as_str().map(|a| a.trim_start_matches("dev-").parse::<usize>().unwrap() + 1).unwrap_or(1);
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<usize> = (start..=DEVICES).take(size).collect();
    let hit = |i: usize, m: f64, t: &str| {
        let arrival = now - 60_000;
        json!({ "hits": { "hits": [ { "_source": { "@timestamp": iso(arrival), "Zone": format!("dc{}", i % 4 + 1), "tag1": "firewall", "fwd_tag": "syslog-dc1-02",
            "parser_tag": "fortigate-grok", "event_created": iso(arrival - (m * 60_000.0) as i64), "log_type": t } } ] } })
    };
    let buckets: Vec<Value> = ids.iter().map(|&i| {
        let types: Vec<Value> = TYPES.iter().enumerate().filter_map(|(k, t)| type_minutes(i, k).map(|m| json!({ "key": t, "doc_count": 30, "latest": hit(i, m, t) }))).collect();
        json!({ "key": { "d": name(i) }, "doc_count": 90, "latest": hit(i, type_minutes(i, 0).unwrap(), TYPES[0]),
                "types": { "sum_other_doc_count": 0, "buckets": types }, "no_type": { "doc_count": 0, "latest": { "hits": { "hits": [] } } } })
    }).collect();
    let mut devices = json!({ "buckets": buckets });
    if let Some(&last) = ids.last() {
        devices["after_key"] = json!({ "d": name(last) });
    }
    let text = json!({ "took": 7, "timed_out": false, "_shards": { "total": 1, "successful": 1, "failed": 0 }, "aggregations": { "devices": devices } }).to_string();
    seen.pages.fetch_add(1, Ordering::SeqCst);
    seen.largest_answer.fetch_max(text.len(), Ordering::SeqCst);
    text
}

async fn typed_core(dir: &TempDir, seen: Arc<Seen>) -> (Arc<Core>, String, TestServer) {
    let srv = TestServer::with(move |hit| {
        if hit.path.contains("/_field_caps") {
            let kw = json!({ "keyword": { "type": "keyword", "aggregatable": true, "searchable": true } });
            let text = json!({ "text": { "type": "text", "aggregatable": false, "searchable": true } });
            return (200, json!({ "indices": ["logstash-1"], "fields": { "log_type": text, "log_type.keyword": kw } }).to_string());
        }
        if hit.path.contains("/_search") {
            return (200, typed_page(&serde_json::from_str(&hit.body).unwrap(), &seen));
        }
        (200, r#"{"cluster_name":"big","status":"green"}"#.into())
    }).await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    let p = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": srv.url() }] })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    let set = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": false, "destination": "builtin", "everyHours": 2, "maxDevices": 30000 } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    (c, s, srv)
}

/// A line of /proc/self/status, MB (`None` off Linux).
fn memory_mb(key: &str) -> Option<u64> {
    let t = std::fs::read_to_string("/proc/self/status").ok()?;
    t.lines().find(|l| l.starts_with(key))?.split_whitespace().nth(1)?.parse::<u64>().ok().map(|kb| kb / 1024)
}

/// The peak counted from here.
fn reset_peak() {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
}

fn files_mb(dir: &TempDir) -> (f64, f64) {
    let mb = |p: &std::path::Path| std::fs::metadata(p).map(|m| m.len() as f64 / 1e6).unwrap_or(0.0);
    let root = dir.0.join("logdelay").join("prod");
    let days = std::fs::read_dir(root.join("m")).map(|d| d.flatten().map(|e| mb(&e.path())).sum()).unwrap_or(0.0);
    (mb(&root.join("tracker.json")), days)
}

/// A cluster that refuses the search by log types is measured without them, and says why.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_search_refused_for_its_log_types_is_read_without_them() {
    let dir = TempDir::new("logdelay-types-refused");
    let asked = Arc::new(AtomicUsize::new(0));
    let (n, refuses) = (asked.clone(), Arc::new(AtomicUsize::new(0)));
    let refuse = refuses.clone();
    let srv = TestServer::with(move |hit| {
        if hit.path.contains("/_field_caps") {
            return (200, json!({ "indices": ["logstash-1"], "fields": { "log_type": { "keyword": { "type": "keyword", "aggregatable": true, "searchable": true } } } }).to_string());
        }
        if hit.path.contains("/_search") {
            if hit.body.contains("\"no_type\"") && refuse.load(Ordering::SeqCst) == 0 {
                let now = chrono::Utc::now();
                let hit = |m: i64, t: &str| json!({ "hits": { "hits": [{ "_source": { "@timestamp": now.to_rfc3339(), "event_created": (now - chrono::Duration::minutes(m)).to_rfc3339(), "log_type": t } }] } });
                let b = json!([{ "key": { "d": "fw-1" }, "doc_count": 9, "latest": hit(2, "a"), "types": { "sum_other_doc_count": 0, "buckets": [
                    { "key": "a", "doc_count": 5, "latest": hit(2, "a") }, { "key": "b", "doc_count": 4, "latest": hit(3, "b") } ] }, "no_type": { "doc_count": 0, "latest": { "hits": { "hits": [] } } } }]);
                return (200, json!({ "took": 1, "timed_out": false, "_shards": { "total": 1, "successful": 1, "failed": 0 }, "aggregations": { "devices": { "buckets": b } } }).to_string());
            }
            if hit.body.contains("\"no_type\"") {
                n.fetch_add(1, Ordering::SeqCst);
                return (503, json!({ "error": { "type": "search_phase_execution_exception", "reason": "", "caused_by": { "type": "too_many_buckets_exception", "reason": "Trying to create too many buckets" } }, "status": 503 }).to_string());
            }
            let b = json!([{ "key": { "d": "fw-1" }, "doc_count": 9, "latest": { "hits": { "hits": [{ "_source": { "@timestamp": chrono::Utc::now().to_rfc3339(), "event_created": (chrono::Utc::now() - chrono::Duration::minutes(95)).to_rfc3339() } }] } } }]);
            return (200, json!({ "took": 1, "timed_out": false, "_shards": { "total": 1, "successful": 1, "failed": 0 }, "aggregations": { "devices": { "buckets": b } } }).to_string());
        }
        (200, r#"{"cluster_name":"c","status":"green"}"#.into())
    }).await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": srv.url() }] })).await;
    // First by log types, on time; then refused, the device over 60 minutes late: it is said late, not kept on time.
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(1)), "{run}");
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 1 })).await;
    assert_eq!((sum["byCluster"][0]["critical"].clone(), sum["byCluster"][0]["logTypes"]["total"].clone()), (json!(0), json!(2)), "{}", sum["byCluster"][0]);
    refuses.store(1, Ordering::SeqCst);
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(1)), "{run}");
    assert_eq!(asked.load(Ordering::SeqCst), 2, "once, and once with smaller pages");
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 1 })).await;
    let row = &sum["byCluster"][0];
    assert_eq!((row["critical"].clone(), row["typesUnread"].clone()), (json!(1), json!(0)), "{row}");
    assert!(row["logTypes"].is_null() && row["logTypeField"].is_null() && row["logTypeWhy"].as_str().unwrap_or("").contains("refused the search by log types"), "{row}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_log_types_a_device_are_read_in_the_same_pages_and_counted_as_generated() {
    let dir = TempDir::new("logdelay-scale-types");
    let seen = Arc::new(Seen::default());
    let (c, s, srv) = typed_core(&dir, seen.clone()).await;
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(DEVICES)), "{run}");
    assert_eq!(seen.pages.load(Ordering::SeqCst), 51, "50 pages of 500 and the empty one: no second search per page");
    assert!(seen.largest_ask.load(Ordering::SeqCst) <= 500);
    assert!(seen.largest_answer.load(Ordering::SeqCst) < 2 * 1024 * 1024, "{}", seen.largest_answer.load(Ordering::SeqCst));
    let caps = srv.hits().iter().filter(|h| h.path.contains("_field_caps")).count();
    assert_eq!(caps, 1, "one mapping request a run, not one a page");
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 1 })).await;
    let n = |f: &dyn Fn(usize) -> bool| (1..=DEVICES).filter(|i| f(*i)).count() as u64;
    let late = n(&|i| i.is_multiple_of(50));
    let part = n(&|i| !i.is_multiple_of(50) && type_minutes(i, 1) == Some(46.0));
    let t = &sum["totals"];
    assert_eq!((t["late"].clone(), t["critical"].clone(), t["partDelayed"].clone()), (json!(late), json!(late), json!(part)), "{t}");
    assert_eq!(t["noDelay"], json!(DEVICES as u64 - late - part), "{t}");
    let pct: f64 = ["pctNoDelay", "pctPartDelayed", "pctLate", "pctOtherTz"].iter().map(|k| t[*k].as_f64().unwrap()).sum();
    assert!((pct - 100.0).abs() < 1e-6, "{t}");
    let series = (1..=DEVICES).map(|i| (0..3).filter(|k| type_minutes(i, *k).is_some()).count() as u64).sum::<u64>();
    assert_eq!(t["logTypes"], json!({ "total": series, "late": late * 3 + part, "above": late * 3 }));
    let bc = &sum["byCluster"][0];
    assert_eq!((bc["logTypeField"].clone(), bc["logTypeWhy"].clone(), bc["logTypesNotKept"].clone()), (json!("log_type.keyword"), Value::Null, json!(0)));
    assert_eq!(sum["byLogType"][0]["logType"], json!("threat"), "{}", sum["byLogType"]);
    let (tracker, day) = files_mb(&dir);
    println!("one run of {DEVICES} devices x 3 log types: tracker.json {tracker:.1} MB, day file {day:.1} MB, VmRSS {:?} MB, VmHWM {:?} MB", memory_mb("VmRSS"), memory_mb("VmHWM"));
    assert!(tracker < 120.0 && day < 40.0, "{tracker} {day}");
}

/// A month of a 25 000-device cluster as a run finds it: 372 points a device, 96 a log type.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "full history: minutes in a debug build; run by hand for the figures"]
async fn the_memory_of_a_full_months_history_with_log_types() {
    use elasticpro_core::logdelay::{levels::State, state::{DeviceState, Point, Tracker}, store::Store};
    const STEP: i64 = 2 * 3_600_000;
    let dir = TempDir::new("logdelay-scale-full");
    let (c, s, _srv) = typed_core(&dir, Arc::new(Seen::default())).await;
    fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    let st = Store::new(&dir.0);
    let now = chrono::Utc::now().timestamp_millis();
    let base = memory_mb("VmRSS").unwrap_or(0);
    let mut t: Tracker = (*st.read_tracker("prod")).clone();
    for (i, d) in t.devices.values_mut().enumerate() {
        let points = |n: i64, at: usize| (1..=n).rev().map(move |k| Point { t: now - k * STEP, m: Some(((i * 37 + at + k as usize * 11) % 2000) as f64 / 100.0), s: State::NoDelay });
        let fill = |d: &mut DeviceState, n: i64, at: usize| { let mut r = std::mem::take(&mut d.recent); r.keep_after(i64::MAX); points(n, at).for_each(|p| r.push(p)); d.recent = r; };
        fill(d, 371, 0);
        for (k, x) in d.types.iter_mut().enumerate() {
            fill(x, 95, k + 1);
        }
    }
    st.put_tracker("prod", t).unwrap();
    let held = memory_mb("VmRSS").unwrap_or(0);
    let (size, _) = files_mb(&dir);
    println!("full history: tracker.json {size:.0} MB; core before {base} MB, with it held {held} MB");
    reset_peak();
    let at = std::time::Instant::now();
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"], "devices": "all" })).await;
    assert_eq!(run["status"], json!("completed"), "{run}");
    println!("a run over it: {:.1} s, VmRSS {:?} MB, peak {:?} MB", at.elapsed().as_secs_f64(), memory_mb("VmRSS"), memory_mb("VmHWM"));
    // Another process wrote it: parsed again.
    let path = dir.0.join("logdelay").join("prod").join("tracker.json");
    let f = std::fs::File::options().append(true).open(&path).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
    reset_peak();
    let at = std::time::Instant::now();
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s, "maxDevices": 100 })).await;
    assert_eq!(sum["totals"]["devices"], json!(DEVICES));
    println!("parsed again and summed: {:.1} s, VmRSS {:?} MB, peak {:?} MB", at.elapsed().as_secs_f64(), memory_mb("VmRSS"), memory_mb("VmHWM"));
    if let Some(peak) = memory_mb("VmHWM") {
        assert!(peak < 900, "the core's limit is 1 GB: {peak} MB");
    }
}
