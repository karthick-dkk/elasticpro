//! The log delay measurement at scale (docs/LOGDELAY.md "Measurement", "Fetch now"): a
//! cluster of 25 000 devices, read in composite pages through *Fetch now*
//! (`JOB_RUN {jobId: "logdelay.measure", clusterIds?, device?}`), with nothing cut.
//!
//!   * every device is read: 25 000 in, 25 000 in the store, the states counted as generated;
//!   * no page asks for more than 1000 devices and no answer is larger than a page of them —
//!     the run never holds the fleet's answer, only its readings;
//!   * *Max devices per run* above 20 000 is a setting, and reaching it is said, without
//!     turning the devices it did not read silent;
//!   * a run scoped to one device reads that device only and changes nobody else;
//!   * the run log shows the progress and the devices measured.

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
    if i % 97 == 0 { Some(-37.0) } else if i % 50 == 0 { Some(95.0) } else if i % 20 == 0 { Some(41.0) } else if i % 33 == 0 { None } else { Some((i % 7) as f64) }
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
    let only = body["query"]["bool"]["filter"].as_array().unwrap().iter().find_map(|f| f["term"].as_object().and_then(|m| m.values().next()).and_then(Value::as_str).map(String::from));
    let start = after.as_deref().map(|a| a.trim_start_matches("dev-").parse::<usize>().unwrap() + 1).unwrap_or(1);
    let now = chrono::Utc::now().timestamp_millis();
    let ids: Vec<usize> = match &only {
        Some(d) => vec![d.trim_start_matches("dev-").parse().unwrap()],
        None => (start..=DEVICES).take(size).collect(),
    };
    let buckets: Vec<Value> = ids.iter().map(|&i| {
        let arrival = now - 60_000;
        let mut src = json!({ "@timestamp": iso(arrival), "Zone": format!("dc{}", i % 4 + 1), "tag1": ["firewall", "proxy", "switch"][i % 3] });
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

    let run = fetch_now(&c, &s, json!({})).await;
    assert_eq!(run["status"], json!("completed"), "{run}");
    assert_eq!(run["records"], json!(DEVICES), "every device measured: {run}");
    assert_eq!((run["done"].clone(), run["total"].clone(), run["progress"].clone()), (json!(1), json!(1), json!(100)), "{run}");
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
    let run = fetch_now(&c, &s, json!({ "clusterIds": ["prod"] })).await;
    assert_eq!((run["status"].clone(), run["records"].clone()), (json!("completed"), json!(20_500)), "{run}");
    assert!(run["note"].as_str().unwrap().contains("Max devices per run"), "{run}");
    let cl = c.handle(json!({ "type": "LOGDELAY_CLUSTER", "session": &s, "clusterId": "prod" })).await;
    assert_eq!((cl["lastRead"]["devices"].clone(), cl["lastRead"]["truncated"].clone(), cl["lastRead"]["maxDevices"].clone()), (json!(20_500), json!(true), json!(20_500)), "{}", cl["lastRead"]);
    assert_eq!(cl["totals"]["silent"], json!(0), "{}", cl["totals"]);
    assert_eq!(cl["counts"]["inLastRun"], json!(20_500));
}
