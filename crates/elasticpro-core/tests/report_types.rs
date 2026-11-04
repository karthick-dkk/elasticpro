//! The indices report and volume by host (docs/REPORT-TYPES.md) through the message API,
//! against a fake cluster that answers `_cat/indices`, `_field_caps`, the search thread pool
//! and composite aggregations paged by `after_key`.
//!
//! `report/{control,hosts,indices,schedule,xlsx,zip}.rs` prove each rule on its own. These
//! prove what only exists assembled:
//!
//!   * a hosts job collects every partition's pages (origin `volume-hosts`), builds a
//!     workbook that opens with Summary first and ClientID/branch filled, and HOSTS_QUERY
//!     reads the same day files back; a day held is not asked again unless *Collect again*;
//!     consecutive pages and thread-pool checks are never answered from an earlier reading;
//!   * a page that keeps failing marks its day failed, and the next try resumes from the
//!     checkpoint — the first page is never asked twice and no row is kept twice;
//!   * one cluster that cannot be read does not cost the others their file;
//!   * the watchdog stops a job between pages, keeps the checkpoint, and the next run resumes;
//!   * the indices report lists dated, undated and closed indices from a fresh listing;
//!   * schedules are per kind, and the daily collection runs from the hosts schedule's time.

mod support;

use base64::Engine as _;
use chrono::{Duration, NaiveDate, Utc};
use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{GaugedServer, Hit, TempDir};

fn today() -> NaiveDate {
    Utc::now().date_naive()
}
fn key(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}
fn dot(d: NaiveDate) -> String {
    d.format("%Y.%m.%d").to_string()
}

/// One host row of the fixture: host, documents, ClientID, branch.
#[derive(Clone)]
struct Row {
    host: Option<String>,
    docs: u64,
    client: Option<&'static str>,
    branch: Option<&'static str>,
}

#[derive(Default)]
struct Plan {
    /// Composite pages that carry an `after` answer 500 this many times.
    fail_after_pages: u32,
    /// Every `_cat/indices` answers 401.
    cat_401: bool,
    /// Composite pages are answered this late.
    page_delay_ms: u64,
}

type Fixture = Arc<Mutex<Vec<(String, Vec<Row>)>>>;

fn rows(n: usize, client: Option<&'static str>, branch: Option<&'static str>) -> Vec<Row> {
    (0..n).map(|i| Row { host: Some(format!("host-{i:05}")), docs: (i as u64 % 7) + 1, client, branch }).collect()
}

/// The composite answer for one page of the indices the query names.
fn composite(fx: &[(String, Vec<Row>)], hit: &Hit) -> Value {
    let body: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
    let asked = support::day_search(hit).map(|s| s.dated).unwrap_or_default();
    let comp = &body["aggs"]["h"]["composite"];
    let size = comp["size"].as_u64().unwrap_or(1000) as usize;
    let after = comp.get("after").cloned();
    let aggs = body["aggs"]["h"]["aggs"].as_object().cloned().unwrap_or_default();
    let mut all: Vec<(String, Option<String>, &Row)> = vec![];
    for (index, rs) in fx.iter().filter(|(n, _)| asked.contains(n)) {
        for r in rs {
            all.push((index.clone(), r.host.clone(), r));
        }
    }
    // Composite order: index, then host with the missing bucket first.
    all.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    if let Some(a) = &after {
        let (ai, ah) = (a["i"].as_str().unwrap_or("").to_string(), a["h"].as_str().map(String::from));
        all.retain(|(i, h, _)| (i.clone(), h.clone()) > (ai.clone(), ah.clone()));
    }
    let page: Vec<Value> = all.iter().take(size).map(|(i, h, r)| {
        let mut b = json!({ "key": { "i": i, "h": h }, "doc_count": r.docs, "ev": { "value": (r.docs * 100) as f64 },
                            "sub": { "value": (r.docs * 10) as f64 }, "m_ev": { "doc_count": 0 } });
        for (name, a) in &aggs {
            if let Some(field) = a.pointer("/terms/field").and_then(Value::as_str) {
                let v = match field { "ClientID" => r.client, "branch" => r.branch, "zone" => Some("z1"), _ => None };
                b[name] = json!({ "buckets": v.map(|v| vec![json!({ "key": v, "doc_count": r.docs })]).unwrap_or_default() });
            }
        }
        b
    }).collect();
    let mut h = json!({ "buckets": page });
    if let Some(last) = h["buckets"].as_array().and_then(|a| a.last()).map(|b| b["key"].clone()) {
        h["after_key"] = last;
    }
    json!({ "took": 1, "timed_out": false, "_shards": { "total": 1, "successful": 1, "failed": 0 }, "aggregations": { "h": h } })
}

async fn cluster(fx: Fixture, plan: Arc<Mutex<Plan>>) -> GaugedServer {
    GaugedServer::start(move |hit: &Hit| {
        let fx = fx.lock().unwrap().clone();
        let mut plan = plan.lock().unwrap();
        if hit.path.starts_with("/_cat/thread_pool/search") {
            return (200, json!([{ "node_name": "n1", "active": "1", "queue": "0", "queue_size": "1000", "rejected": "0" }]).to_string(), 0);
        }
        if hit.path.starts_with("/_cat/indices/") {
            if plan.cat_401 {
                return (401, r#"{"error":{"reason":"secret-token-xyz is not valid"},"status":401}"#.into(), 0);
            }
            let mut rows: Vec<Value> = fx.iter().map(|(n, rs)| {
                let docs: u64 = rs.iter().map(|r| r.docs).sum();
                json!({ "index": n, "status": "open", "health": "green", "docs.count": docs.to_string(),
                        "pri.store.size": (docs * 1000).to_string(), "store.size": (docs * 2000).to_string(), "creation.date": "1793577600000" })
            }).collect();
            rows.push(json!({ "index": "logstash-gone-2020.01.01", "status": "close" }));
            rows.push(json!({ "index": "logstash-nodate", "status": "open", "docs.count": "9", "pri.store.size": "90", "creation.date": "1793577600000" }));
            return (200, Value::Array(rows).to_string(), 0);
        }
        if hit.path.contains("/_field_caps") {
            let kw = json!({ "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } });
            let long = json!({ "long": { "type": "long", "searchable": true, "aggregatable": true } });
            return (200, json!({ "indices": [], "fields": {
                "src_hostname": kw, "ClientID": kw, "branch": kw, "event_logsize": long, "fwd_log_size": long,
                "zone": { "text": { "type": "text", "searchable": true, "aggregatable": false } }, "zone.keyword": kw,
                "@timestamp": { "date": { "type": "date", "searchable": true, "aggregatable": true } },
            } }).to_string(), 0);
        }
        if hit.path.contains("/_search") && hit.body.contains("\"composite\"") {
            let delay = plan.page_delay_ms;
            if hit.body.contains("\"after\"") && plan.fail_after_pages > 0 {
                plan.fail_after_pages -= 1;
                return (500, r#"{"error":{"type":"search_phase_execution_exception"},"status":500}"#.into(), delay);
            }
            return (200, composite(&fx, hit).to_string(), delay);
        }
        (404, r#"{"error":"not here"}"#.into(), 0)
    })
    .await
}

fn with_session(mut m: Value, s: Option<&str>) -> Value {
    if let Some(s) = s {
        m["session"] = json!(s);
    }
    m
}

async fn ended(c: &Arc<Core>, id: &str) -> Value {
    for _ in 0..1200 {
        let r = c.handle(with_session(json!({ "type": "REPORT_JOBS" }), None)).await;
        if let Some(j) = r["jobs"].as_array().and_then(|a| a.iter().find(|j| j["id"] == id)) {
            if !matches!(j["status"].as_str(), Some("queued" | "running")) {
                return j.clone();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("job {id} did not end");
}

fn unzip(b64: &str) -> Vec<(String, Vec<u8>)> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    elasticpro_core::report::zip::read(&bytes).unwrap()
}

fn part(parts: &[(String, Vec<u8>)], name: &str) -> String {
    String::from_utf8(parts.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no {name}")).1.clone()).unwrap()
}

fn composites(es: &GaugedServer) -> Vec<Hit> {
    es.hits().into_iter().filter(|h| h.path.contains("/_search") && h.body.contains("\"composite\"")).collect()
}

async fn run(c: &Arc<Core>, m: Value) -> Value {
    let r = c.handle(m).await;
    assert_eq!(r["ok"], true, "{r}");
    let id = r["jobs"][0]["id"].as_str().unwrap_or_else(|| panic!("{r}")).to_string();
    ended(c, &id).await
}

fn period(from: NaiveDate, to: NaiveDate) -> Value {
    json!({ "from": key(from), "to": key(to) })
}

#[tokio::test]
async fn a_hosts_job_pages_every_partition_builds_the_book_and_the_view_reads_it_back() {
    let (d1, d2) = (today() - Duration::days(1), today() - Duration::days(2));
    let fx: Fixture = Arc::new(Mutex::new(vec![
        (format!("logstash-linux-{}", dot(d1)), rows(2500, Some("C42"), Some("BLR"))),
        (format!("logstash-win-{}", dot(d1)), vec![
            Row { host: None, docs: 4, client: None, branch: None },
            Row { host: Some("dc1".into()), docs: 5, client: Some("__missing__"), branch: None },
        ]),
        (format!("logstash-app-{}", dot(d2)), vec![Row { host: Some("a1".into()), docs: 3, client: Some("None"), branch: None }]),
        (format!("logstash-bpp-{}", dot(d2)), vec![Row { host: Some("b1".into()), docs: 2, client: Some("C7"), branch: Some("HYD") }]),
    ]));
    let es = cluster(fx, Arc::new(Mutex::new(Plan::default()))).await;
    let dir = TempDir::new("report-hosts");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    c.set_report_backoff_for_tests([0, 0, 0]);
    let p = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": es.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");

    let job = run(&c, json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["prod"], "period": period(d2, d1), "format": "xlsx" })).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["report"], "hosts");
    assert_eq!(job["progress"]["clusters"]["prod"]["state"], "done", "{job}");
    assert_eq!(job["progress"]["clusters"]["prod"]["days"], json!({ "done": 2, "total": 2 }));
    assert_eq!(job["reportKind"], "hosts");
    let parts = &job["progress"]["partitions"];
    assert_eq!((parts["done"].as_u64(), parts["total"].as_u64()), (Some(6), Some(6)), "{job}");
    assert!(job["progress"]["concurrency"].as_u64().is_some() && job["progress"]["halvings"].is_u64());
    assert!(job["progress"]["clusters"]["prod"]["concurrency"].as_u64().unwrap() >= 1);
    let pages = composites(&es);
    // d1: three partitions (linux 2500 rows = 3 pages, win 1, the undated index split by time 1);
    // d2: three partitions, a page each.
    assert_eq!(pages.len(), 8, "{}", pages.len());
    assert_eq!(pages.iter().filter(|h| h.body.contains("\"after\"")).count(), 2, "the linux partition's 2nd and 3rd pages carry after_key");
    assert!(pages.iter().all(|h| h.header("x-opaque-id").is_some_and(|v| v.contains("volume-hosts"))), "origin volume-hosts");
    assert!(es.hits().iter().all(|h| h.method == "GET" || h.path.contains("/_search")), "reads only");
    assert!(pages.iter().all(|h| h.body.contains("\"missing_bucket\":true")));

    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "id": job["id"] })).await;
    assert_eq!(d["ok"], true, "{d}");
    assert_eq!(d["name"], format!("hosts-prod-{}_{}.xlsx", key(d2), key(d1)));
    let parts = unzip(d["base64"].as_str().unwrap());
    let wb = part(&parts, "xl/workbook.xml");
    assert!(wb.contains(r#"name="Summary" sheetId="1""#) && wb.contains(r#"name="Production""#), "{wb}");
    let summary = part(&parts, "xl/worksheets/sheet1.xml");
    assert!(summary.contains("Actual total") && summary.contains("Production"), "{summary}");
    // The first ClientID in day, index order: d2's app row says None, bpp says C7.
    assert!(summary.contains(">C7<") && summary.contains(">DC<") && summary.contains(">HYD<"), "{summary}");
    let sheet = part(&parts, "xl/worksheets/sheet2.xml");
    assert!(sheet.contains("host-02499") && sheet.contains("(no host)"), "every row, the missing host bucket too");
    assert!(sheet.contains(">linux<") && sheet.contains("zone"), "Source is the name less its date; metadata columns");

    // The view: the same files, filled the same way.
    let v = c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "period": period(d2, d1), "limit": 5, "sort": "-docs" })).await;
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["total"], 2504);
    assert_eq!(v["rows"].as_array().unwrap().len(), 5);
    assert_eq!(v["rows"][0]["docs"], 7, "sorted by documents, descending");
    let all_docs: u64 = 4 + 5 + 3 + 2 + (0..2500u64).map(|i| i % 7 + 1).sum::<u64>();
    assert_eq!(v["totals"]["docs"], all_docs);
    assert_eq!(v["totals"]["eventBytes"], all_docs * 100);
    assert_eq!(v["days"].as_array().unwrap().iter().filter(|d| d["held"] == true).count(), 2);
    let q = c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "period": period(d2, d1), "q": "dc1" })).await;
    assert_eq!(q["total"], 1);
    assert_eq!((q["rows"][0]["clientId"].as_str(), q["rows"][0]["branch"].as_str()), (Some("C7"), Some("DC")));
    assert_eq!(c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "limit": 500 })).await["kind"], "bad_request");
    assert_eq!(c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "nope" })).await["kind"], "not_found");

    // Held days are not asked again; Collect again asks them all. The thread-pool check and
    // every page reach the cluster although the same requests went out seconds ago.
    let pools_before = es.hits().iter().filter(|h| h.path.starts_with("/_cat/thread_pool")).count();
    let again = run(&c, json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["prod"], "period": period(d2, d1), "format": "csvzip" })).await;
    assert_eq!(again["status"], "done", "{again}");
    assert_eq!(composites(&es).len(), 8, "nothing asked again");
    let pools_after = es.hits().iter().filter(|h| h.path.starts_with("/_cat/thread_pool")).count();
    assert_eq!(pools_after, pools_before + 1, "the thread-pool check is not answered from a reading");
    let csv = c.handle(json!({ "type": "REPORT_DOWNLOAD", "id": again["id"] })).await;
    let parts = unzip(csv["base64"].as_str().unwrap());
    assert!(part(&parts, "summary.csv").starts_with("cluster,client_id,branch,month,day,docs,event_bytes,sub_bytes,note\n"));
    assert!(part(&parts, "prod.csv").contains("host-00001"));
    let fresh = run(&c, json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["prod"], "period": period(d2, d1), "collectAgain": true })).await;
    assert_eq!(fresh["status"], "done");
    assert_eq!(composites(&es).len(), 16, "every page again, each one sent");

    // At most five clusters, refused whole.
    let six: Vec<String> = (0..6).map(|i| format!("c{i}")).collect();
    let r = c.handle(json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": six })).await;
    assert_eq!(r["kind"], "too_many_clusters", "{r}");
    assert_eq!(c.handle(json!({ "type": "REPORT_RUN", "kind": "pdf", "clusterIds": ["prod"] })).await["kind"], "bad_request");
}

#[tokio::test]
async fn a_failed_page_resumes_from_its_checkpoint_and_a_lost_cluster_does_not_cost_the_file() {
    let d1 = today() - Duration::days(1);
    let fx: Fixture = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(d1)), rows(2500, Some("C1"), Some("B1")))]));
    // The second page fails four times: the page and its three retries. The job tries the
    // cluster once more at its end, and that try resumes after page one.
    let plan = Arc::new(Mutex::new(Plan { fail_after_pages: 4, ..Plan::default() }));
    let es = cluster(fx.clone(), plan.clone()).await;
    let lost = cluster(fx, Arc::new(Mutex::new(Plan { cat_401: true, ..Plan::default() }))).await;
    let dir = TempDir::new("report-hosts-resume");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    c.set_report_backoff_for_tests([0, 0, 0]);
    let p = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [
        { "id": "prod", "name": "Production", "url": es.url() }, { "id": "lost", "name": "Lost", "url": lost.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    let job = run(&c, json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["prod", "lost"], "period": period(d1, d1), "format": "xlsx", "mail": false })).await;
    assert_eq!(job["status"], "done", "a job never fails whole for one cluster: {job}");
    let pages = composites(&es);
    let linux: Vec<&Hit> = pages.iter().filter(|h| h.body.contains("logstash-linux")).collect();
    assert_eq!(linux.iter().filter(|h| !h.body.contains("\"after\"")).count(), 1, "the first page is never asked twice");
    assert_eq!(linux.len(), 1 + 4 + 2, "page 1, four failures of page 2, then pages 2 and 3");
    assert_eq!(job["failedClusters"].as_array().unwrap().len(), 1, "{job}");
    assert_eq!(job["failedClusters"][0]["clusterId"], "lost");
    let why = job["failedClusters"][0]["reason"].as_str().unwrap();
    assert!(why.contains("401") && !why.contains("secret"), "named, never the error body: {why}");
    assert_eq!(lost.hits().iter().filter(|h| h.path.starts_with("/_cat/indices")).count(), 2, "tried once more at the end");
    assert!(job["warning"].as_str().unwrap().contains("lost"));
    let v = c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "period": period(d1, d1), "limit": 1 })).await;
    assert_eq!(v["total"], 2500, "no row kept twice: {}", v["total"]);
    // The file names the cluster that could not be read.
    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "id": job["id"] })).await;
    let parts = unzip(d["base64"].as_str().unwrap());
    let summary = part(&parts, "xl/worksheets/sheet1.xml");
    assert!(summary.contains("not collected"), "{summary}");
    let lost_sheet = part(&parts, "xl/worksheets/sheet3.xml");
    assert!(lost_sheet.contains("not collected this time"), "its sheet's first row says why: {lost_sheet}");
    let hosts_dir = dir.join("volume").join("prod").join("hosts");
    assert!(hosts_dir.join(format!("{}.json.gz", key(d1))).is_file());
    assert!(!hosts_dir.join(format!("{}.partial.json", key(d1))).exists(), "the checkpoint goes with the last page");
}

#[tokio::test]
async fn the_watchdog_stops_between_pages_keeps_the_checkpoint_and_the_next_run_resumes() {
    let d1 = today() - Duration::days(1);
    let fx: Fixture = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(d1)), rows(2500, Some("C1"), None))]));
    let plan = Arc::new(Mutex::new(Plan { page_delay_ms: 300, ..Plan::default() }));
    let es = cluster(fx, plan.clone()).await;
    let dir = TempDir::new("report-hosts-watchdog");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    c.set_report_backoff_for_tests([0, 0, 0]);
    c.set_report_watchdog_for_tests(400);
    let p = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "prod", "url": es.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    let job = run(&c, json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["prod"], "period": period(d1, d1) })).await;
    assert_eq!(job["status"], "done", "the file is built for what was held: {job}");
    let why = job["failedClusters"][0]["reason"].as_str().unwrap_or_default();
    assert!(why.contains("ran longer than"), "{job}");
    let hosts_dir = dir.join("volume").join("prod").join("hosts");
    let cp: Value = serde_json::from_slice(&std::fs::read(hosts_dir.join(format!("{}.partial.json", key(d1)))).expect("the checkpoint is kept")).unwrap();
    assert!(cp["interrupted"].as_str().unwrap().contains("ran longer than"), "{cp}");
    assert!(!hosts_dir.join(format!("{}.json.gz", key(d1))).exists(), "no day file before its last page");
    let first_pages = composites(&es).iter().filter(|h| h.body.contains("logstash-linux") && !h.body.contains("\"after\"")).count();
    assert_eq!(first_pages, 1);

    c.set_report_watchdog_for_tests(600_000);
    plan.lock().unwrap().page_delay_ms = 0;
    let again = run(&c, json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["prod"], "period": period(d1, d1) })).await;
    assert_eq!(again["status"], "done", "{again}");
    assert!(again["failedClusters"].is_null(), "{again}");
    assert_eq!(composites(&es).iter().filter(|h| h.body.contains("logstash-linux") && !h.body.contains("\"after\"")).count(), first_pages, "resumed, not restarted");
    assert!(hosts_dir.join(format!("{}.json.gz", key(d1))).is_file());
    let v = c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "period": period(d1, d1), "limit": 1 })).await;
    assert_eq!(v["total"], 2500);
}

#[tokio::test]
async fn the_indices_report_lists_a_fresh_listing_by_day_and_names_a_cluster_it_could_not_read() {
    let d1 = today() - Duration::days(1);
    let fx: Fixture = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(d1)), rows(3, None, None))]));
    let es = cluster(fx.clone(), Arc::new(Mutex::new(Plan::default()))).await;
    let lost = cluster(fx, Arc::new(Mutex::new(Plan { cat_401: true, ..Plan::default() }))).await;
    let dir = TempDir::new("report-indices");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    c.set_report_backoff_for_tests([0, 0, 0]);
    let p = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [
        { "id": "prod", "name": "Production", "url": es.url() }, { "id": "lost", "name": "Lost", "url": lost.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    let job = run(&c, json!({ "type": "REPORT_RUN", "kind": "indices", "clusterIds": ["prod", "lost"], "period": period(d1 - Duration::days(1), d1) })).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["report"], "indices");
    let cats: Vec<Hit> = es.hits().into_iter().filter(|h| h.path.starts_with("/_cat/indices")).collect();
    assert_eq!(cats.len(), 1, "one fresh listing per cluster");
    assert!(cats[0].path.contains("h=index,status,health,docs.count,pri.store.size,creation.date"), "{}", cats[0].path);
    assert!(cats[0].header("x-opaque-id").is_some_and(|v| v.contains("volume-indices")));
    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "id": job["id"] })).await;
    let parts = unzip(d["base64"].as_str().unwrap());
    let wb = part(&parts, "xl/workbook.xml");
    assert!(wb.contains(r#"name="Totals""#) && wb.contains(r#"name="Production""#) && wb.contains(r#"name="Lost""#), "{wb}");
    let totals = part(&parts, "xl/worksheets/sheet1.xml");
    assert!(totals.contains("Month total") && totals.contains("not measured") && totals.contains("did not answer: HTTP 401"), "{totals}");
    assert!(!totals.contains("secret"), "the error body never lands in the file");
    let prod = part(&parts, "xl/worksheets/sheet2.xml");
    assert!(prod.contains(&format!("logstash-linux-{}", dot(d1))) && prod.contains("No date in the name") && prod.contains("logstash-nodate"), "{prod}");
    assert!(!prod.contains("logstash-gone-2020.01.01"), "outside the period");
}

#[tokio::test]
async fn schedules_are_per_kind_and_the_daily_collection_runs_from_the_hosts_time() {
    let ms = elasticpro_core::report::period::month_so_far(today());
    let fx: Fixture = Arc::new(Mutex::new(ms.days().iter().map(|d| (format!("logstash-linux-{}", dot(*d)), rows(2, Some("C1"), None))).collect()));
    let es = cluster(fx, Arc::new(Mutex::new(Plan::default()))).await;
    let dir = TempDir::new("report-hosts-tick");
    // A schedule file from before 0.3.54: one object, the volume report's.
    std::fs::write(dir.join("report-schedule.json"), r#"{"enabled":false,"to":["a@example.com"],"schedule":"monthly","at":"07:30"}"#).unwrap();
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let p = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "prod", "url": es.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    let v = c.handle(json!({ "type": "REPORT_SCHEDULE_GET" })).await;
    assert_eq!((v["kind"].as_str(), v["schedule"].as_str(), v["at"].as_str()), (Some("volume"), Some("monthly"), Some("07:30")), "{v}");
    let h = c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "kind": "hosts" })).await;
    assert_eq!((h["enabled"].as_bool(), h["schedule"].as_str(), h["at"].as_str(), h["period"].as_str()), (Some(false), Some("daily"), Some("06:00"), Some("monthSoFar")), "{h}");
    assert!(h["collection"]["fields"].as_array().unwrap().iter().any(|f| f == "ClientID"));
    assert_eq!(h["nextPeriod"]["to"], ms.to.as_str());
    let i = c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "kind": "indices" })).await;
    assert_eq!((i["at"].as_str(), i.get("sheets")), (Some("08:00"), None));
    let on = c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "kind": "indices", "enabled": true })).await;
    assert_eq!(on["kind"], "bad_request", "a mail is a person's decision: recipients first: {on}");
    let set = c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "kind": "indices", "enabled": true, "to": ["ops@example.com"], "at": "09:15" })).await;
    assert_eq!((set["ok"].as_bool(), set["at"].as_str()), (Some(true), Some("09:15")), "{set}");
    assert_eq!(c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "kind": "hosts", "sheets": ["daily"] })).await["kind"], "bad_request");
    let file: Value = serde_json::from_slice(&std::fs::read(dir.join("report-schedule.json")).unwrap()).unwrap();
    assert_eq!(file["volume"]["at"], "07:30", "the old schedule kept as the volume report's: {file}");
    assert_eq!(file["indices"]["to"], json!(["ops@example.com"]));
    assert_eq!(c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "kind": "pie" })).await["kind"], "bad_request");

    // The daily collection: not before 06:00 local; from then on, the month so far.
    let local = |t: &str| chrono::NaiveDateTime::parse_from_str(&format!("{} {t}", chrono::Local::now().date_naive()), "%Y-%m-%d %H:%M").unwrap();
    assert!(c.hosts_tick_at(local("05:59")).await.is_empty());
    assert_eq!(c.hosts_tick_at(local("06:00")).await, vec!["prod".to_string()]);
    for _ in 0..400 {
        let q = c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "period": "monthSoFar", "limit": 1 })).await;
        if q["days"].as_array().is_some_and(|d| d.iter().all(|x| x["held"] == true)) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let q = c.handle(json!({ "type": "HOSTS_QUERY", "clusterId": "prod", "period": "monthSoFar", "limit": 1 })).await;
    assert!(q["days"].as_array().unwrap().iter().all(|x| x["held"] == true), "{q}");
    assert_eq!(q["total"], (ms.days().len() * 2) as u64);
    assert!(c.hosts_tick_at(local("06:30")).await.is_empty(), "nothing missing: nothing asked");
}
