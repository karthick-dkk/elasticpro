//! The daily volume record through the real message API, against a fake cluster that
//! answers `_cat/indices`, `_field_caps` and the per-day aggregation search.
//!
//! `volume/*.rs` prove each rule on its own. These prove what only exists assembled:
//!
//!   * a finished day is searched once and never again; today is searched every run;
//!   * a day whose indices were deleted keeps its record and turns `live: false`;
//!   * a field the mapping does not have is `null`, never 0;
//!   * the Daily cards and the change against the average are the contract's figures;
//!   * Refresh now is once a minute per cluster;
//!   * nothing reaches the cluster before a run is due or asked for — counted in TCP
//!     accepts, not read off a return value;
//!   * and on hosted, every message needs a caller with the right role.

mod support;

use chrono::{Duration, NaiveDate, NaiveDateTime, Utc};
use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{GaugedServer, TempDir, TestServer};

type Listing = Arc<Mutex<Vec<(String, u64)>>>;

fn today() -> NaiveDate {
    Utc::now().date_naive()
}
fn dot(d: NaiveDate) -> String {
    d.format("%Y.%m.%d").to_string()
}
fn dash(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// A cluster with day indices. `with_event` decides whether the mapping has
/// `event_logsize`; documents per index are its primary size, so shares are easy to read.
/// An index without a day in its name has no documents in the kept months.
async fn cluster(listing: Listing, with_event: bool) -> TestServer {
    cluster_split(listing, with_event, vec![]).await
}

/// As `cluster`, with documents in indices split by time: `(index, YYYY-MM-DD, docs)`.
/// Searches come as the legacy format sends them (the day in the path) or as an index
/// pattern does (the indices, and the time-split ones' day, in the query).
async fn cluster_split(listing: Listing, with_event: bool, split: Vec<(String, String, u64)>) -> TestServer {
    TestServer::with(move |hit| {
        let all = listing.lock().unwrap().clone();
        if hit.path.starts_with("/_cat/indices/") {
            let rows: Vec<Value> = all.iter().map(|(n, pri)| json!({
                "index": n, "status": "open", "docs.count": pri.to_string(),
                "pri.store.size": pri.to_string(), "store.size": (pri * 2).to_string(),
            })).collect();
            return (200, Value::Array(rows).to_string());
        }
        if hit.path.contains("/_field_caps") {
            let mut fields = json!({
                "tag1": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
                "sub_size": { "long": { "type": "long", "searchable": true, "aggregatable": true } },
                "@timestamp": { "date": { "type": "date", "searchable": true, "aggregatable": true } },
            });
            if with_event {
                fields["event_logsize"] = json!({ "long": { "type": "long", "searchable": true, "aggregatable": true } });
            }
            return (200, json!({ "indices": [], "fields": fields }).to_string());
        }
        if let Some(names) = support::histogram_indices(hit) {
            let mut days: Vec<&String> = split.iter().filter(|(n, _, c)| names.contains(n) && *c > 0).map(|(_, d, _)| d).collect();
            days.sort();
            days.dedup();
            let buckets: Vec<Value> = days.iter().map(|d| json!({ "key_as_string": d, "key": 0, "doc_count": 1 })).collect();
            return (200, json!({ "hits": { "total": { "value": 0 } }, "aggregations": { "days": { "buckets": buckets } } }).to_string());
        }
        type Asked = (Vec<String>, Vec<(String, u64)>);
        let asked: Option<Asked> = match hit.path.strip_prefix("/logstash-*-") {
            Some(rest) => {
                let day = rest.split('/').next().unwrap_or("").to_string();
                Some((all.iter().filter(|(n, _)| n.ends_with(&day)).map(|(n, _)| n.clone()).collect(), vec![]))
            }
            None => support::day_search(hit).map(|s| {
                let day = s.day.unwrap_or_default();
                let counted = split.iter().filter(|(n, d, _)| s.split.contains(n) && *d == day).map(|(n, _, c)| (n.clone(), *c)).collect();
                (s.dated, counted)
            }),
        };
        if let Some((dated, counted)) = asked {
            let mut mine: Vec<(String, u64)> = all.iter().filter(|(n, _)| dated.contains(n)).cloned().collect();
            mine.extend(counted);
            let docs: u64 = mine.iter().map(|(_, p)| *p).sum();
            let buckets: Vec<Value> = mine.iter().map(|(n, p)| json!({
                "key": n, "doc_count": p, "sub": { "value": (*p / 10) as f64 }, "ev": { "value": (*p * 3) as f64 },
            })).collect();
            return (200, json!({ "hits": { "total": { "value": docs, "relation": "eq" } }, "aggregations": {
                "sub": { "value": (docs / 10) as f64 }, "ev": { "value": (docs * 3) as f64 },
                "by_index": { "sum_other_doc_count": 0, "buckets": buckets },
                "f_tag": { "sum_other_doc_count": docs - docs / 2, "buckets": [
                    { "key": "fw", "doc_count": docs / 2, "sub": { "value": 1.0 } },
                ] },
                "m_tag": { "doc_count": 0, "sub": { "value": 0.0 } },
            } }).to_string());
        }
        (404, r#"{"error":"not here"}"#.into())
    })
    .await
}

/// Searches for day `d`: the legacy format names it in the path, the pattern in the query.
fn searches_for(srv: &TestServer, d: NaiveDate) -> usize {
    srv.hits().iter().filter(|h| h.path.contains("/_search")
        && (h.path.contains(&dot(d)) || support::day_search(h).is_some_and(|s| s.dated.iter().any(|n| n.contains(&dot(d))) || s.day == Some(dash(d)))))
        .count()
}

async fn portable(dir: &TempDir, url: &str) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "prod", "url": url }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c
}

/// Wait for the cluster's run to finish, through the status the page reads.
async fn settle(c: &Arc<Core>, id: &str) -> Value {
    for _ in 0..200 {
        let r = c.handle(json!({ "type": "VOLUME_DAILY", "clusterId": id, "days": 14, "avgDays": 3 })).await;
        if r["status"]["running"] == json!(false) {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the run did not finish");
}

fn row(daily: &Value, d: NaiveDate) -> &Value {
    daily["days"].as_array().unwrap().iter().find(|r| r["day"] == dash(d)).unwrap_or_else(|| panic!("no row for {d}: {daily}"))
}

fn local(d: NaiveDate, hhmm: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(&format!("{} {hhmm}", dash(d)), "%Y-%m-%d %H:%M").unwrap()
}

#[tokio::test]
async fn finished_days_once_today_every_run_and_a_deleted_day_is_kept() {
    let t = today();
    let (d1, d2, d3) = (t - Duration::days(1), t - Duration::days(2), t - Duration::days(3));
    let listing: Listing = Arc::new(Mutex::new(vec![
        (format!("logstash-linux-{}", dot(t)), 1000),
        (format!("logstash-linux-{}", dot(d1)), 200),
        (format!("logstash-win-dc-{}", dot(d1)), 100),
        (format!("logstash-linux-{}", dot(d2)), 200),
        (format!("logstash-linux-{}", dot(d3)), 100),
        ("logstash-linux-2026.10".into(), 7),
    ]));
    let srv = cluster(listing.clone(), false).await;
    let dir = TempDir::new("volume-runs");
    let c = portable(&dir, &srv.url()).await;

    // First run: Refresh now.
    let r = c.handle(json!({ "type": "VOLUME_RUN" })).await;
    assert_eq!(r["started"], json!(["prod"]), "{r}");
    settle(&c, "prod").await;
    for d in [t, d1, d2, d3] {
        assert_eq!(searches_for(&srv, d), 1, "{d} searched once on the first run");
    }
    // The built-in pattern logstash-*: the pattern in the path, the day's indices in the query.
    let search = srv.hits().into_iter().find(|h| support::day_search(h).is_some()).unwrap();
    assert_eq!(search.path, "/logstash-*/_search?ignore_unavailable=true&allow_no_indices=true");
    assert_eq!(search.header("x-opaque-id").map(|v| v.contains("volume-daily")), Some(true), "origin volume-daily in the request log");
    let body: Value = serde_json::from_str(&search.body).unwrap();
    assert!(body["aggs"].get("ev").is_none(), "event_logsize is not mapped: no ev agg: {body}");
    assert_eq!(body["aggs"]["sub"], json!({ "sum": { "field": "sub_size" } }));
    assert_eq!(body["aggs"]["f_tag"]["terms"], json!({ "field": "tag1", "size": 25 }));

    // Refresh now again, at once: too soon.
    let again = c.handle(json!({ "type": "VOLUME_RUN", "clusterIds": ["prod"] })).await;
    assert_eq!(again["tooSoon"], json!(["prod"]), "{again}");
    assert_eq!(again["started"], json!([]));

    // The oldest day's indices are deleted; the timer runs the next scheduled run.
    listing.lock().unwrap().retain(|(n, _)| !n.ends_with(&dot(d3)));
    let before = srv.connections();
    assert!(c.volume_tick_at(local(t, "05:59")).await.is_empty(), "before collectAt: not due");
    assert_eq!(srv.connections(), before, "a tick that is not due sends nothing");
    assert_eq!(c.volume_tick_at(local(t, "06:00")).await, vec!["prod".to_string()]);
    let daily = settle(&c, "prod").await;
    assert_eq!(searches_for(&srv, t), 2, "today is searched every run");
    for d in [d1, d2, d3] {
        assert_eq!(searches_for(&srv, d), 1, "{d} was final: not searched again");
    }
    assert!(c.volume_tick_at(local(t, "09:00")).await.is_empty(), "no repeat the same local day");

    // What the record says now.
    let gone = row(&daily, d3);
    assert_eq!(gone["live"], false, "{gone}");
    assert_eq!((gone["priBytes"].as_u64(), gone["docs"].as_u64()), (Some(100), Some(100)), "kept as measured");
    assert_eq!(row(&daily, d1)["final"], true);
    assert_eq!(row(&daily, t)["final"], false);
    assert_eq!(row(&daily, d1)["indices"], 2);
    // Not measured is null, never 0.
    assert_eq!(row(&daily, d1)["eventBytes"], Value::Null, "{}", row(&daily, d1));
    assert_eq!(row(&daily, d1)["subBytes"], 30);
    assert_eq!(daily["cards"]["eventBytes30"]["value"], Value::Null);
    assert_eq!(daily["skipped"], json!([]), "a pattern skips nothing it matches");
    assert_eq!(daily["timeSplit"], 1, "logstash-linux-2026.10 has no day in its name: split by time");
    assert_eq!(daily["matched"], 5, "d3's index is gone");
    assert_eq!(daily["sources"], json!(["linux", "win-dc"]));

    // The cards and the change against the average (avgDays 3).
    assert_eq!(daily["cards"]["yesterday"], json!({ "day": dash(d1), "value": 300, "changeVsAvgPct": 100.0 }),
               "300 against the two days before it, (200 + 100) / 2");
    // The totals row: what the shown rows add up to, unmeasured event bytes still null.
    assert_eq!(daily["totals"]["eventBytes"], Value::Null, "{}", daily["totals"]);
    assert_eq!(daily["totals"]["days"], daily["days"].as_array().unwrap().len());
    assert_eq!(daily["cards"]["average"]["value"], 200, "(300 + 200 + 100) / 3");
    assert_eq!(daily["cards"]["average"]["daysWithData"], 3);
    let month: u64 = [(t, 1000u64), (d1, 300), (d2, 200), (d3, 100)].iter()
        .filter(|(d, _)| d.format("%Y-%m").to_string() == t.format("%Y-%m").to_string()).map(|(_, v)| v).sum();
    assert_eq!(daily["cards"]["monthSoFar"]["value"], month);
    let r1 = row(&daily, d1);
    assert_eq!((r1["basis"].as_u64(), r1["avg"].as_u64(), r1["changeVsAvgPct"].as_f64()), (Some(300), Some(150), Some(100.0)),
               "d1 against the mean of d2 and d3: {r1}");
    assert_eq!(row(&daily, d3)["changeVsAvgPct"], Value::Null, "no earlier day");
    assert_eq!(r1["top"]["tag"], json!({ "value": "fw", "docs": 150, "share": 0.5 }));

    // A source filter: that source's totals, no top values.
    let win = c.handle(json!({ "type": "VOLUME_DAILY", "clusterId": "prod", "days": 14, "avgDays": 3, "source": "win-dc" })).await;
    assert_eq!(win["days"].as_array().unwrap().len(), 1);
    assert_eq!((win["days"][0]["priBytes"].as_u64(), win["days"][0]["docs"].as_u64()), (Some(100), Some(100)));
    assert_eq!(win["days"][0]["top"]["tag"], Value::Null);
    assert_eq!(win["topAvailable"], false);

    // Months, from state.json; the all-cluster view; a breakdown.
    let m = c.handle(json!({ "type": "VOLUME_MONTHLY", "clusterId": "prod" })).await;
    let days_in: u64 = m["months"].as_array().unwrap().iter().map(|r| r["daysWithData"].as_u64().unwrap()).sum();
    assert_eq!(days_in, 4, "{m}");
    let kept: u64 = m["months"].as_array().unwrap().iter().map(|r| r["keptDays"].as_u64().unwrap()).sum();
    assert_eq!(kept, 1);
    let all = c.handle(json!({ "type": "VOLUME_MONTHLY_ALL" })).await;
    assert_eq!(all["clusters"][0]["clusterId"], "prod", "{all}");
    let b = c.handle(json!({ "type": "VOLUME_BREAKDOWN", "clusterId": "prod", "field": "tag", "from": dash(d3), "to": dash(t) })).await;
    assert_eq!(b["ok"], true, "{b}");
    assert_eq!(b["rows"][0]["value"], "fw");
    assert_eq!(b["rows"][0]["docs"], (1000 + 300 + 200 + 100) / 2);
    assert_eq!(b["totals"]["estPriBytes"], 1600, "the estimate adds up to the primary size");
    let bad = c.handle(json!({ "type": "VOLUME_BREAKDOWN", "clusterId": "prod", "field": "nope" })).await;
    assert_eq!(bad["kind"], "bad_request");

    // The files: gzipped months and a state.json, 0600.
    let cdir = dir.join("volume").join("prod");
    assert!(cdir.join("state.json").is_file());
    assert!(cdir.join(format!("{}.json.gz", t.format("%Y-%m"))).is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(cdir.join("state.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn a_measured_event_field_is_summed() {
    let t = today();
    let listing: Listing = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(t - Duration::days(1))), 400)]));
    let srv = cluster(listing, true).await;
    let dir = TempDir::new("volume-event");
    let c = portable(&dir, &srv.url()).await;
    let check = c.handle(json!({ "type": "VOLUME_FIELDS_CHECK", "clusterId": "prod" })).await;
    assert_eq!(check["indices"]["match"], 1, "{check}");
    let ev = check["rows"].as_array().unwrap().iter().find(|r| r["key"] == "eventSize").unwrap().clone();
    assert_eq!(ev["resolved"], "event_logsize");
    let host = check["rows"].as_array().unwrap().iter().find(|r| r["key"] == "sourceHost").unwrap().clone();
    assert_eq!(host["resolved"], Value::Null);
    assert!(host["note"].as_str().unwrap().contains("not in the mapping"), "{host}");

    c.handle(json!({ "type": "VOLUME_RUN" })).await;
    let daily = settle(&c, "prod").await;
    assert_eq!(row(&daily, t - Duration::days(1))["eventBytes"], 1200);
    assert_eq!(daily["cards"]["eventBytes30"]["value"], 1200);
}

/// A clusters file (here: the desktop message) that names only the legacy `indexFormat`
/// keeps the requests it always sent: the day's indices by name in the path, the names
/// that do not fit skipped, nothing split by time.
#[tokio::test]
async fn the_legacy_index_format_keeps_its_requests() {
    let t = today();
    let listing: Listing = Arc::new(Mutex::new(vec![
        (format!("logstash-linux-{}", dot(t - Duration::days(1))), 400),
        ("logstash-linux-2026.10".into(), 7),
    ]));
    let srv = cluster(listing, true).await;
    let dir = TempDir::new("volume-legacy");
    let c = portable(&dir, &srv.url()).await;
    let volume = json!({ "defaults": { "indexFormat": "logstash-*-YYYY.MM.DD" } });
    let s = c.handle(json!({ "type": "VOLUME_SETTINGS", "clusterId": "prod", "volume": volume })).await;
    assert_eq!(s["patternSource"], "format", "{s}");
    let r = c.handle(json!({ "type": "VOLUME_RUN", "clusterIds": ["prod"], "volume": volume })).await;
    assert_eq!(r["started"], json!(["prod"]), "{r}");
    let daily = settle(&c, "prod").await;
    let hits = srv.hits();
    assert!(hits.iter().any(|h| h.path == "/_cat/indices/logstash-*-*?format=json&bytes=b&h=index,status,docs.count,pri.store.size,store.size"));
    let search = hits.iter().find(|h| h.path.contains("/_search")).unwrap();
    assert_eq!(search.path, format!("/logstash-*-{}/_search?ignore_unavailable=true&allow_no_indices=true", dot(t - Duration::days(1))));
    assert!(!search.body.contains("\"query\""), "no query: the day is the path, as before");
    assert!(!hits.iter().any(|h| h.body.contains("date_histogram")), "nothing split by time");
    assert_eq!(daily["skipped"], json!(["logstash-linux-2026.10"]));
    assert_eq!(row(&daily, t - Duration::days(1))["priBytes"], 400);
}

/// An index without a day in its name is counted per UTC day of its time field: one
/// histogram finds the days, each day's search counts them; documents and event bytes are
/// measured, the size of such a day is not (null, never 0, never shared out).
#[tokio::test]
async fn an_index_without_a_date_is_split_by_its_time_field() {
    let t = today();
    let (d1, d2) = (t - Duration::days(1), t - Duration::days(2));
    let listing: Listing = Arc::new(Mutex::new(vec![
        (format!("logstash-linux-{}", dot(d1)), 400),
        ("logstash-app".into(), 9999),
    ]));
    let srv = cluster_split(listing, true, vec![
        ("logstash-app".into(), dash(d1), 100),
        ("logstash-app".into(), dash(d2), 50),
    ]).await;
    let dir = TempDir::new("volume-split");
    let c = portable(&dir, &srv.url()).await;
    let check = c.handle(json!({ "type": "VOLUME_FIELDS_CHECK", "clusterId": "prod" })).await;
    assert_eq!((check["indices"]["dated"].as_u64(), check["indices"]["timeSplit"].as_u64()), (Some(1), Some(1)), "{check}");
    assert_eq!(check["timeField"]["resolved"], true, "{check}");
    c.handle(json!({ "type": "VOLUME_RUN" })).await;
    let daily = settle(&c, "prod").await;
    assert_eq!(daily["status"]["lastError"], Value::Null, "{}", daily["status"]);
    let histograms = srv.hits().iter().filter(|h| support::histogram_indices(h).is_some()).count();
    assert_eq!(histograms, 1, "one histogram per run");
    // d1: dated in full (400) and 100 time-split documents; its size is not the day's.
    let r1 = row(&daily, d1);
    assert_eq!((r1["docs"].as_u64(), r1["eventBytes"].as_u64()), (Some(500), Some(1500)), "{r1}");
    assert_eq!((r1["priBytes"].clone(), r1["unmeasuredSizeIndices"].as_u64(), r1["indices"].as_u64()), (Value::Null, Some(1), Some(2)));
    assert_eq!(r1["final"], true);
    // d2: only time-split documents.
    let r2 = row(&daily, d2);
    assert_eq!((r2["docs"].as_u64(), r2["priBytes"].clone(), r2["totalBytes"].clone()), (Some(50), Value::Null, Value::Null), "{r2}");
    assert_eq!(daily["totals"]["sizeUnmeasuredDays"], 2);
    // The source of an undated index is its name less the pattern's prefix.
    assert_eq!(daily["sources"], json!(["app", "linux"]));
    let app = c.handle(json!({ "type": "VOLUME_DAILY", "clusterId": "prod", "days": 14, "avgDays": 3, "source": "app" })).await;
    assert_eq!(app["days"].as_array().unwrap().len(), 2, "{app}");
    // Finished days are not asked again; the histogram is (it is how new days are found).
    let before = searches_for(&srv, d2);
    c.volume_tick_at(local(t, "06:00")).await;
    settle(&c, "prod").await;
    assert_eq!(searches_for(&srv, d2), before, "d2 was final");
}

/// The Config card's pattern preview: an admin's (a limited admin's only on their
/// clusters), one names-only `_cat/indices` request as a person, matching nothing is an answer.
#[tokio::test]
async fn the_pattern_preview_counts_what_a_pattern_would_match() {
    let t = today();
    let listing: Listing = Arc::new(Mutex::new(vec![
        (format!("logstash-linux-{}", dot(t)), 1), ("logstash-app".into(), 1),
    ]));
    let srv = cluster(listing, true).await;
    let dir = TempDir::new("volume-preview");
    let c = portable(&dir, &srv.url()).await;
    let r = c.handle(json!({ "type": "VOLUME_PATTERN_CHECK", "clusterId": "prod", "indexPattern": "logstash-*" })).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!((r["matched"].as_u64(), r["dated"].as_u64(), r["undated"].as_u64()), (Some(2), Some(1), Some(1)));
    assert_eq!((r["datedExample"].clone(), r["undatedExample"].clone()), (json!(format!("logstash-linux-{}", dot(t))), json!("logstash-app")));
    let hit = srv.hits().into_iter().find(|h| h.path.starts_with("/_cat/indices/logstash-*")).unwrap();
    assert_eq!(hit.path, "/_cat/indices/logstash-*?format=json&h=index");
    assert!(hit.header("x-opaque-id").is_some_and(|v| v.contains("volume-pattern-check")), "a person asked");
    let time = c.handle(json!({ "type": "VOLUME_PATTERN_CHECK", "clusterId": "prod", "indexPattern": "logstash-*", "dayFrom": "time" })).await;
    assert_eq!((time["dated"].as_u64(), time["undated"].as_u64()), (Some(0), Some(2)));
    let bad = c.handle(json!({ "type": "VOLUME_PATTERN_CHECK", "clusterId": "prod", "indexPattern": "a b" })).await;
    assert_eq!(bad["kind"], "bad_request", "{bad}");
    let unknown = c.handle(json!({ "type": "VOLUME_PATTERN_CHECK", "clusterId": "nope", "indexPattern": "x-*" })).await;
    assert_eq!(unknown["ok"], false, "{unknown}");
    // Elasticsearch refusing: ok false with the reason.
    let down = TestServer::with(|_| (500, r#"{"error":{"type":"x","reason":"broken"}}"#.into())).await;
    let dir2 = TempDir::new("volume-preview-down");
    let c2 = portable(&dir2, &down.url()).await;
    let e = c2.handle(json!({ "type": "VOLUME_PATTERN_CHECK", "clusterId": "prod", "indexPattern": "x-*" })).await;
    assert_eq!(e["ok"], false, "{e}");
    assert!(e["message"].as_str().unwrap().starts_with("_cat/indices:"), "{e}");
}

#[tokio::test]
async fn nothing_is_sent_before_a_run_is_due_or_asked() {
    let listing: Listing = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(today())), 1)]));
    let srv = cluster(listing, true).await;
    let dir = TempDir::new("volume-quiet");
    let c = portable(&dir, &srv.url()).await;
    let start = srv.connections();
    // Reading the record, the settings and the layouts never asks the cluster.
    for m in [
        json!({ "type": "VOLUME_SETTINGS", "clusterId": "prod" }),
        json!({ "type": "VOLUME_DAILY", "clusterId": "prod" }),
        json!({ "type": "VOLUME_MONTHLY", "clusterId": "prod" }),
        json!({ "type": "VOLUME_MONTHLY_ALL" }),
        json!({ "type": "VOLUME_BREAKDOWN", "clusterId": "prod", "field": "tag" }),
        json!({ "type": "VOLUME_LAYOUT_GET" }),
    ] {
        let r = c.handle(m.clone()).await;
        assert_eq!(r["ok"], true, "{m} -> {r}");
    }
    // A tick before collectAt, with a collectAt the message cannot change on the timer.
    assert!(c.volume_tick_at(local(today(), "00:00")).await.is_empty());
    assert_eq!(srv.connections(), start, "nothing reached the cluster");

    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "clusterId": "prod" })).await;
    assert_eq!(daily["status"]["lastRunAt"], Value::Null);
    assert_eq!(daily["status"]["running"], false);
    assert_eq!(daily["status"]["nextRunAt"], Value::Null, "portable has no timer, so no next run");
    assert_eq!(daily["days"], json!([]));
    assert_eq!(daily["cards"]["yesterday"]["value"], Value::Null, "no record is not 0");
    let s = c.handle(json!({ "type": "VOLUME_SETTINGS", "clusterId": "prod",
                             "volume": { "defaults": { "topValues": 40 }, "cluster": { "collectAt": "07:15" } } })).await;
    assert_eq!(s["source"], "message", "no config file: the message's settings");
    assert_eq!((s["settings"]["topValues"].as_u64(), s["settings"]["collectAt"].as_str()), (Some(40), Some("07:15")));
    assert_eq!(c.handle(json!({ "type": "VOLUME_SETTINGS" })).await["source"], "builtin");
}

#[tokio::test]
async fn the_shared_layout_is_validated_and_kept() {
    let dir = TempDir::new("volume-layout");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "VOLUME_LAYOUT_SET", "table": "daily",
                             "layout": { "order": ["docs", "day"], "hidden": ["subBytes"], "labels": { "docs": "Events" } } })).await;
    assert_eq!(r["ok"], true, "{r}");
    let g = c.handle(json!({ "type": "VOLUME_LAYOUT_GET" })).await;
    assert_eq!(g["layouts"]["daily"]["order"][0], "docs");
    assert_eq!(g["layouts"]["daily"]["hidden"], json!(["subBytes"]));
    assert_eq!(g["layouts"]["daily"]["labels"], json!({ "docs": "Events" }));
    assert_eq!(g["layouts"]["monthly"]["order"][0], "month", "untouched table: its defaults");
    for bad in [
        json!({ "table": "weekly", "layout": {} }),
        json!({ "table": "daily", "layout": { "order": ["day", "nope"] } }),
        json!({ "table": "monthly", "layout": { "hidden": ["topTag"] } }),
        json!({ "table": "daily", "layout": { "labels": { "docs": "x".repeat(61) } } }),
        json!({ "table": "daily", "layout": { "labels": { "docs": "a\nb" } } }),
        json!({ "table": "capacity", "layout": { "order": ["perDay", "cluster"] } }),
        json!({ "table": "capacity", "layout": { "hidden": ["cluster"] } }),
        json!({ "table": "overview", "layout": { "hidden": ["priBytes"] } }),
    ] {
        let mut m = bad.clone();
        m["type"] = json!("VOLUME_LAYOUT_SET");
        assert_eq!(c.handle(m).await["kind"], "bad_request", "{bad}");
    }
    // The Reports tables (0.3.53): capacity and overview, cluster locked first.
    let cap = c.handle(json!({ "type": "VOLUME_LAYOUT_SET", "table": "capacity",
                               "layout": { "order": ["cluster", "backupDisk", "perDay"], "hidden": ["buffered"], "labels": { "perDay": "Per day (avg 7)" } } })).await;
    assert_eq!(cap["ok"], true, "{cap}");
    assert_eq!(cap["layouts"]["capacity"]["order"][1], "backupDisk");
    assert_eq!(cap["layouts"]["capacity"]["hidden"], json!(["buffered"]));
    let ov = c.handle(json!({ "type": "VOLUME_LAYOUT_SET", "table": "overview", "layout": { "hidden": ["type", "daily"] } })).await;
    assert_eq!(ov["ok"], true, "{ov}");
    assert_eq!(ov["layouts"]["overview"]["order"][0], "cluster");
    assert_eq!(ov["layouts"]["daily"]["order"][0], "docs", "the other tables are left as they were");
    // Kept across a restart.
    let c2 = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    assert_eq!(c2.handle(json!({ "type": "VOLUME_LAYOUT_GET" })).await["layouts"]["capacity"]["labels"], json!({ "perDay": "Per day (avg 7)" }));
    assert_eq!(c2.handle(json!({ "type": "VOLUME_LAYOUT_GET" })).await["layouts"]["daily"]["labels"], json!({ "docs": "Events" }));
}

const PASSWORD: &str = "correct-horse-battery";

#[tokio::test]
async fn on_hosted_every_message_needs_a_caller_with_the_right_role() {
    let listing: Listing = Arc::new(Mutex::new(vec![]));
    let srv = cluster(listing, true).await;
    let dir = TempDir::new("volume-roles");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    for t in ["VOLUME_SETTINGS", "VOLUME_FIELDS_CHECK", "VOLUME_DAILY", "VOLUME_MONTHLY", "VOLUME_BREAKDOWN",
              "VOLUME_MONTHLY_ALL", "VOLUME_RUN", "VOLUME_LAYOUT_GET", "VOLUME_LAYOUT_SET", "VOLUME_PATTERN_CHECK"] {
        let r = c.handle(json!({ "type": t, "clusterId": "prod" })).await;
        assert_eq!(r["kind"], "unauthenticated", "{t}: {r}");
    }
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = r["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], true, "{ch}");
    let p = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": true, "clusters": [{ "id": "prod", "url": srv.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    let mut sessions = std::collections::HashMap::new();
    for (name, role) in [("gus", "guest"), ("ursula", "user"), ("otto", "operator")] {
        let a = c.handle(json!({ "type": "USER_ADD", "session": s, "name": name, "password": PASSWORD, "role": role })).await;
        assert_eq!(a["ok"], true, "{a}");
        let l = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
        sessions.insert(name, l["session"].as_str().unwrap().to_string());
    }
    let guest = c.handle(json!({ "type": "VOLUME_DAILY", "session": sessions["gus"], "clusterId": "prod" })).await;
    assert_eq!(guest["kind"], "forbidden", "{guest}");
    assert_eq!(c.handle(json!({ "type": "VOLUME_LAYOUT_GET", "session": sessions["gus"] })).await["ok"], true);
    let user = c.handle(json!({ "type": "VOLUME_DAILY", "session": sessions["ursula"], "clusterId": "prod" })).await;
    assert_eq!(user["ok"], true, "{user}");
    assert!(user["status"]["nextRunAt"].is_i64(), "hosted has a timer, so a next run: {user}");
    let set = json!({ "type": "VOLUME_LAYOUT_SET", "table": "monthly", "layout": { "hidden": ["from"] } });
    let mut as_user = set.clone();
    as_user["session"] = json!(sessions["ursula"]);
    assert_eq!(c.handle(as_user).await["kind"], "forbidden");
    let mut as_op = set.clone();
    as_op["session"] = json!(sessions["otto"]);
    assert_eq!(c.handle(as_op).await["ok"], true);
    // The pattern preview: an admin's; an admin limited to some Zabbix groups only on the
    // clusters those groups map to (prod is mapped to none).
    let check = json!({ "type": "VOLUME_PATTERN_CHECK", "clusterId": "prod", "indexPattern": "logstash-*" });
    let mut as_op = check.clone();
    as_op["session"] = json!(sessions["otto"]);
    assert_eq!(c.handle(as_op).await["kind"], "forbidden");
    let mut as_admin = check.clone();
    as_admin["session"] = json!(s);
    let a = c.handle(as_admin).await;
    assert_eq!((a["ok"].clone(), a["matched"].clone()), (json!(true), json!(0)), "matching nothing is an answer: {a}");
    let limited = elasticpro_core::auth::Caller { name: "lim".into(), role: elasticpro_core::auth::Role::Admin, must_change: false,
                                                  scope: Some(vec!["team-a".into()]), play: None };
    let l = c.handle_as(check.clone(), Some(limited)).await;
    assert_eq!(l["kind"], "forbidden", "{l}");
    // Hosted with no config file (no ELASTICPRO_CONFIG): built-in, whatever the message says.
    let msg_settings = c.handle(json!({ "type": "VOLUME_SETTINGS", "session": sessions["ursula"],
                                        "volume": { "defaults": { "topValues": 99 } } })).await;
    assert_eq!(msg_settings["ok"], true, "{msg_settings}");
    assert_eq!(msg_settings["source"], "builtin", "a request cannot set what hosted counts");
    assert_eq!(msg_settings["settings"]["topValues"], 25);
}

async fn stop(c: &Arc<Core>, on: bool) {
    // The stop's own messages: POLICY_SET leaves the stop alone.
    let msg = if on { json!({ "type": "POLICY_PAUSE", "minutes": 30 }) } else { json!({ "type": "POLICY_RESUME" }) };
    let r = c.handle(msg).await;
    assert_eq!(r["ok"], true, "{r}");
}

async fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !f() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// A scheduled run that the emergency stop ends — here while it waited for one of the two
/// permits — is run again on the first tick after the stop is lifted. One that finished is
/// not: still once a day.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scheduled_run_the_stop_ended_is_run_after_the_stop() {
    let t = today();
    // Four clusters, each its own server; `_cat` answers slowly and lists nothing, so a run
    // that gets to send it finishes without any further request.
    let mut servers = vec![];
    for _ in 0..4 {
        servers.push(GaugedServer::start(|hit| {
            if hit.path.starts_with("/_cat/indices/") { (200, "[]".into(), 600) } else { (404, "{}".into(), 0) }
        }).await);
    }
    let cats = |s: &GaugedServer| s.hits().iter().filter(|h| h.path.starts_with("/_cat/indices/")).count();
    let dir = TempDir::new("volume-stop-queue");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let ids = ["c0", "c1", "c2", "c3"];
    let clusters: Vec<Value> = ids.iter().zip(&servers).map(|(id, s)| json!({ "id": id, "url": s.url() })).collect();
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": clusters })).await;
    assert_eq!(r["ok"], true, "{r}");

    assert_eq!(c.volume_tick_at(local(t, "06:00")).await.len(), 4, "all four due");
    // Two hold the permits and have sent `_cat`; the other two wait. Then the stop.
    wait_for("two runs to reach their cluster", || servers.iter().filter(|s| cats(s) > 0).count() == 2).await;
    stop(&c, true).await;
    for id in ids {
        settle(&c, id).await;
    }
    let ran: Vec<&str> = ids.iter().zip(&servers).filter(|(_, s)| cats(s) == 1).map(|(id, _)| *id).collect();
    let waited: Vec<&str> = ids.iter().zip(&servers).filter(|(_, s)| cats(s) == 0).map(|(id, _)| *id).collect();
    assert_eq!((ran.len(), waited.len()), (2, 2), "nothing was sent for the two that waited");
    for id in &waited {
        let d = c.handle(json!({ "type": "VOLUME_DAILY", "clusterId": id })).await;
        let e = d["status"]["lastError"].as_str().unwrap_or("");
        assert!(e.contains("emergency stop") && e.contains("tried again"), "{id}: {d}");
    }
    assert!(c.volume_tick_at(local(t, "06:01")).await.is_empty(), "nothing while the stop holds");

    stop(&c, false).await;
    let mut again = c.volume_tick_at(local(t, "06:02")).await;
    again.sort();
    assert_eq!(again, waited, "the two the stop held back, and not the two that finished");
    for id in ids {
        settle(&c, id).await;
    }
    assert!(servers.iter().all(|s| cats(s) == 1), "each cluster asked once today");
    assert!(c.volume_tick_at(local(t, "09:00")).await.is_empty(), "and still once a day");
}

/// Desktop messages about several clusters apply each one's override from
/// `volume.clusters[id]`; VOLUME_MONTHLY says which settings its rows are under.
#[tokio::test]
async fn desktop_messages_about_several_clusters_use_each_ones_override() {
    let t = today();
    let la: Listing = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(t - Duration::days(1))), 10)]));
    let lb: Listing = Arc::new(Mutex::new(vec![(format!("logstash-linux-{}", dot(t - Duration::days(1))), 10)]));
    let (sa, sb) = (cluster(la, false).await, cluster(lb, false).await);
    let dir = TempDir::new("volume-desktop-many");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true,
                             "clusters": [{ "id": "a", "url": sa.url() }, { "id": "b", "url": sb.url() }] })).await;
    assert_eq!(r["ok"], true, "{r}");
    let volume = json!({ "defaults": { "topValues": 30 }, "cluster": { "topValues": 99 },
                         "clusters": { "a": { "topValues": 50, "sizeBasis": "total" }, "b": { "volumeFields": ["kind_x"] } } });
    let run = c.handle(json!({ "type": "VOLUME_RUN", "volume": volume })).await;
    assert_eq!(run["started"], json!(["a", "b"]), "{run}");
    settle(&c, "a").await;
    settle(&c, "b").await;
    let size = |s: &TestServer| -> Value {
        let h = s.hits().into_iter().find(|h| h.path.contains("/_search")).expect("a search");
        serde_json::from_str::<Value>(&h.body).unwrap()["aggs"]["f_tag"]["terms"]["size"].clone()
    };
    assert_eq!(size(&sa), 50, "a's override from clusters.a, not the message's `cluster`");
    assert_eq!(size(&sb), 30, "b has no topValues of its own: the defaults'");
    let fc = sb.hits().into_iter().find(|h| h.path.contains("/_field_caps")).unwrap();
    assert!(fc.path.contains("kind_x"), "b's legacy volumeFields became its extra row: {}", fc.path);
    let fa = sa.hits().into_iter().find(|h| h.path.contains("/_field_caps")).unwrap();
    assert!(!fa.path.contains("kind_x"), "and not a's: {}", fa.path);

    let all = c.handle(json!({ "type": "VOLUME_MONTHLY_ALL", "volume": volume })).await;
    let basis: Vec<(String, String)> = all["clusters"].as_array().unwrap().iter()
        .map(|x| (x["clusterId"].as_str().unwrap().to_string(), x["basis"].as_str().unwrap().to_string())).collect();
    assert_eq!(basis, vec![("a".to_string(), "total".to_string()), ("b".to_string(), "primary".to_string())], "{all}");

    let m = c.handle(json!({ "type": "VOLUME_MONTHLY", "clusterId": "a", "volume": volume })).await;
    assert_eq!(m["settings"]["sizeBasis"], "total", "VOLUME_MONTHLY carries the settings its rows are under: {m}");
    assert_eq!(m["settings"]["topValues"], 50, "clusters.a is a's override, not the unkeyed `cluster`");
    assert_eq!(m["months"][0]["basis"], "total");
    let mb = c.handle(json!({ "type": "VOLUME_MONTHLY", "clusterId": "b", "volume": volume })).await;
    assert_eq!(mb["settings"]["extra"]["fields"], json!(["kind_x"]), "{mb}");
    let own = c.handle(json!({ "type": "VOLUME_MONTHLY", "clusterId": "b",
                               "volume": { "defaults": { "topValues": 30 }, "cluster": { "topValues": 99 } } })).await;
    assert_eq!(own["settings"]["topValues"], 99, "about one cluster with nothing keyed: `cluster` is its override");
}
