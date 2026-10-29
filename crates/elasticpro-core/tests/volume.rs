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
use support::{TempDir, TestServer};

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
async fn cluster(listing: Listing, with_event: bool) -> TestServer {
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
            });
            if with_event {
                fields["event_logsize"] = json!({ "long": { "type": "long", "searchable": true, "aggregatable": true } });
            }
            return (200, json!({ "indices": [], "fields": fields }).to_string());
        }
        if let Some(rest) = hit.path.strip_prefix("/logstash-*-") {
            let day = rest.split('/').next().unwrap_or("");
            let mine: Vec<&(String, u64)> = all.iter().filter(|(n, _)| n.ends_with(day)).collect();
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

fn searches_for(srv: &TestServer, d: NaiveDate) -> usize {
    srv.hits().iter().filter(|h| h.path.contains("/_search") && h.path.contains(&dot(d))).count()
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
    let search = srv.hits().into_iter().find(|h| h.path.contains("/_search")).unwrap();
    assert!(search.path.starts_with("/logstash-*-") && search.path.contains("ignore_unavailable=true&allow_no_indices=true"), "{}", search.path);
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
    assert_eq!(daily["skipped"], json!(["logstash-linux-2026.10"]));
    assert_eq!(daily["sources"], json!(["linux", "win-dc"]));

    // The cards and the change against the average (avgDays 3).
    assert_eq!(daily["cards"]["yesterday"], json!({ "day": dash(d1), "value": 300 }));
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
    ] {
        let mut m = bad.clone();
        m["type"] = json!("VOLUME_LAYOUT_SET");
        assert_eq!(c.handle(m).await["kind"], "bad_request", "{bad}");
    }
    // Kept across a restart.
    let c2 = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
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
              "VOLUME_MONTHLY_ALL", "VOLUME_RUN", "VOLUME_LAYOUT_GET", "VOLUME_LAYOUT_SET"] {
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
    // Hosted with no config file (no ELASTICPRO_CONFIG): built-in, whatever the message says.
    let msg_settings = c.handle(json!({ "type": "VOLUME_SETTINGS", "session": sessions["ursula"],
                                        "volume": { "defaults": { "topValues": 99 } } })).await;
    assert_eq!(msg_settings["ok"], true, "{msg_settings}");
    assert_eq!(msg_settings["source"], "builtin", "a request cannot set what hosted counts");
    assert_eq!(msg_settings["settings"]["topValues"], 25);
}
