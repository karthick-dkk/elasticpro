//! The log delay report (docs/LOGDELAY.md) through the message API, against a fake cluster
//! whose devices change between runs.
//!
//! `logdelay/*.rs` prove each rule on its own. These prove what only exists assembled:
//!
//!   * the built-in destination measures and writes nothing to any cluster;
//!   * three runs open, continue and solve a period, and every LOGDELAY_* read agrees;
//!   * the roles: a user reads, a guest does not, an operator cannot change the settings;
//!   * the `log_delay` report kind builds a workbook with a Fixes sheet and a CSV, and mails
//!     them as multipart text + HTML; its schedule carries options.

mod support;

use base64::Engine as _;
use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{TempDir, TestServer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PASSWORD: &str = "correct-horse-battery";

/// The devices answer, switched between runs: `(fw-1 delay minutes)`.
type Knob = Arc<Mutex<f64>>;

fn devices(fw1_minutes: f64) -> Value {
    let arrival = "2026-11-04T14:00:00Z";
    let event = |m: f64| {
        let ms = elasticpro_core::delay_sink::parse_rfc3339_ms(arrival).unwrap() - (m * 60_000.0) as i64;
        let (y, mo, d) = elasticpro_core::delay_sink::civil_from_days(ms.div_euclid(86_400_000));
        let rest = ms.rem_euclid(86_400_000);
        format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z", rest / 3_600_000, (rest % 3_600_000) / 60_000, (rest % 60_000) / 1000)
    };
    json!({ "took": 5, "aggregations": { "devices": { "buckets": [
        { "key": "fw-1", "doc_count": 120, "latest": { "hits": { "hits": [ { "_source": {
            "@timestamp": arrival, "ingested_time": event(fw1_minutes), "Zone": "dc1", "fwd_tag": "syslog-dc1-02", "parser_tag": "fortigate-grok", "tag1": "firewall" } } ] } } },
        { "key": "fw-2", "doc_count": 80, "latest": { "hits": { "hits": [ { "_source": {
            "@timestamp": arrival, "ingested_time": event(2.0), "Zone": "dc2", "fwd_tag": "syslog-dc2-01", "parser_tag": "fortigate-grok", "tag1": "firewall" } } ] } } },
        { "key": "app-3", "doc_count": 4, "latest": { "hits": { "hits": [ { "_source": { "@timestamp": arrival, "Zone": "dc1" } } ] } } },
    ] } } })
}

/// An IST cluster: every device's event time is 330 min before its arrival (its logs are on
/// time, stamped in local time); `sg` sits at +08:00; `slow` is 330 + 40 min behind.
fn devices_ist() -> Value {
    let arrival = "2026-11-04T14:00:00Z";
    let event = |m: f64| {
        let ms = elasticpro_core::delay_sink::parse_rfc3339_ms(arrival).unwrap() - (m * 60_000.0) as i64;
        let (y, mo, d) = elasticpro_core::delay_sink::civil_from_days(ms.div_euclid(86_400_000));
        let rest = ms.rem_euclid(86_400_000);
        format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z", rest / 3_600_000, (rest % 3_600_000) / 60_000, (rest % 60_000) / 1000)
    };
    let mut buckets: Vec<Value> = (1..=8).map(|i| json!({ "key": format!("fw-{i}"), "doc_count": 100, "latest": { "hits": { "hits": [ { "_source": {
        "@timestamp": arrival, "event_created": event(330.0 + (i % 2) as f64), "Zone": "DC1", "tag1": "firewall" } } ] } } })).collect();
    buckets.push(json!({ "key": "sg", "doc_count": 50, "latest": { "hits": { "hits": [ { "_source": { "@timestamp": arrival, "event_created": event(480.0), "Zone": "SG", "tag1": "switch" } } ] } } }));
    buckets.push(json!({ "key": "slow", "doc_count": 50, "latest": { "hits": { "hits": [ { "_source": { "@timestamp": arrival, "event_created": event(370.0), "Zone": "DC1", "tag1": "proxy" } } ] } } }));
    json!({ "took": 5, "aggregations": { "devices": { "buckets": buckets } } })
}

async fn ist_cluster() -> TestServer {
    TestServer::with(move |hit| {
        if hit.path.contains("/_search") {
            return (200, devices_ist().to_string());
        }
        (200, r#"{"cluster_name":"ist","status":"green"}"#.into())
    })
    .await
}

#[tokio::test]
async fn an_ist_cluster_is_detected_after_three_runs_and_a_set_zone_is_corrected_from_the_first() {
    let dir = TempDir::new("logdelay-tz");
    let srv = ist_cluster().await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    // Two clusters at the same fake: one left to detection, one set to Asia/Kolkata in its config.
    let p = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [
        { "id": "ist", "name": "IST detect", "url": srv.url() },
        { "id": "ist-set", "name": "IST set", "url": srv.url(), "logTimeZone": "Asia/Kolkata" } ] })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    let g = c.handle(json!({ "type": "LOGDELAY_SETTINGS_GET", "session": &s })).await;
    let res = g["resolved"].as_array().unwrap();
    assert_eq!((res[0]["id"].clone(), res[0]["logTimeZone"].clone(), res[0]["timeZone"]["mode"].clone()), (json!("ist"), json!("detect"), json!("none")), "{g}");
    assert_eq!((res[1]["logTimeZone"].clone(), res[1]["timeZone"]["mode"].clone(), res[1]["timeZone"]["offsetMinutes"].clone()), (json!("Asia/Kolkata"), json!("set"), json!(330)), "{g}");
    assert_eq!(g["timeZones"]["toleranceMinutes"], json!(3.0));
    let armed = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": true, "destination": "builtin", "everyHours": 2 } })).await;
    assert_eq!(armed["ok"], json!(true), "{armed}");

    // Run 1: the detected cluster shows the offset as delay (nothing corrected yet); the set one is right at once.
    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(true), "{run}");
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s })).await;
    let by = |sum: &Value, id: &str| sum["byCluster"].as_array().unwrap().iter().find(|x| x["id"] == id).cloned().unwrap();
    let det = by(&sum, "ist");
    assert_eq!((det["critical"].clone(), det["timeZone"]["mode"].clone(), det["timeZone"]["pct"].clone()), (json!(10), json!("none"), json!(80.0)), "{det}");
    let set = by(&sum, "ist-set");
    assert_eq!((set["critical"].clone(), set["delay"].clone(), set["timeZone"]["mode"].clone(), set["timeZone"]["zone"].clone()), (json!(1), json!(1), json!("set"), json!("Asia/Kolkata")), "{set}");
    let fixes = c.handle(json!({ "type": "LOGDELAY_FIXES", "session": &s, "clusterIds": ["ist"] })).await;
    let cl = fixes["findings"].as_array().unwrap().iter().find(|f| f["step"] == "cluster").cloned().expect("a Cluster finding: set the zone");
    assert!(cl["fix"].as_str().unwrap().starts_with("check the devices' clocks"), "{cl}");
    assert_eq!(cl["devices"].as_array().unwrap().len(), 8, "{cl}");

    // Runs 2 and 3: detected (the set cluster's zone names it), every IST device on time, slow 40 min late,
    // sg in another time zone — not late.
    c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &s })).await;
    let det = by(&sum, "ist");
    assert_eq!(det["timeZone"]["mode"], json!("detected"), "{det}");
    assert_eq!((det["timeZone"]["offsetMinutes"].clone(), det["timeZone"]["offset"].clone(), det["timeZone"]["zone"].clone()), (json!(330), json!("+05:30"), json!("Asia/Kolkata")), "{det}");
    assert_eq!((det["critical"].clone(), det["delay"].clone(), det["otherTz"].clone(), det["lateNow"].clone()), (json!(0), json!(1), json!(1), json!(1)), "{det}");
    assert_eq!(sum["totals"]["otherTz"], json!(2), "both clusters' sg");
    let cl = c.handle(json!({ "type": "LOGDELAY_CLUSTER", "session": &s, "clusterId": "ist" })).await;
    assert_eq!(cl["timeZone"]["mode"], json!("detected"), "{cl}");
    let row = |name: &str| cl["devices"].as_array().unwrap().iter().find(|d| d["device"] == name).cloned().unwrap();
    let fw = row("fw-2");
    assert_eq!((fw["state"].clone(), fw["nowMinutes"].clone(), fw["rawGapMinutes"].clone(), fw["tzOffsetMinutes"].clone(), fw["clusterTzOffset"].clone()),
               (json!("no_delay"), json!(0.0), json!(330.0), json!(330), json!(330)), "{fw}");
    let slow = row("slow");
    assert_eq!((slow["state"].clone(), slow["nowMinutes"].clone(), slow["rawGapMinutes"].clone()), (json!("delay"), json!(40.0), json!(370.0)), "{slow}");
    let sg = row("sg");
    assert_eq!((sg["state"].clone(), sg["nowMinutes"].clone(), sg["deviceTzOffset"].clone(), sg["tzOffsetMinutes"].clone()), (json!("other_tz"), json!(0.0), json!(480), json!(480)), "{sg}");
    let dev = c.handle(json!({ "type": "LOGDELAY_DEVICE", "session": &s, "clusterId": "ist", "device": "sg" })).await;
    assert_eq!((dev["state"].clone(), dev["rawGapMinutes"].clone(), dev["timeZone"]["mode"].clone()), (json!("other_tz"), json!(480.0), json!("detected")), "{dev}");
    let fixes = c.handle(json!({ "type": "LOGDELAY_FIXES", "session": &s, "clusterIds": ["ist"] })).await;
    let fs = fixes["findings"].as_array().unwrap();
    let dz = fs.iter().find(|f| f["step"] == "device_time_zone").cloned().expect("a device time zone finding");
    assert_eq!(dz["devices"], json!(["sg"]));
    assert_eq!(dz["stepLabel"], json!("Device clock / parser"));
    assert!(dz["fix"].as_str().unwrap().contains("timezone =>"), "{dz}");
    let cl = fs.iter().find(|f| f["step"] == "cluster").cloned().expect("a Cluster finding: confirm the zone");
    assert!(cl["fix"].as_str().unwrap().starts_with("nothing to set"), "{cl}");
    // The measurement documents carry the raw gap and what was taken out.
    let day = std::fs::read_dir(dir.join("logdelay").join("ist").join("m")).unwrap().filter_map(|e| e.ok()).map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "ndjson")).map(|p| std::fs::read_to_string(p).unwrap_or_default()).unwrap_or_default();
    assert!(day.contains("\"raw_gap_minutes\"") && day.contains("\"tz_offset_minutes\""), "{}", &day[..day.len().min(400)]);
}

async fn cluster(knob: Knob) -> TestServer {
    TestServer::with(move |hit| {
        if hit.path.starts_with("/_bulk") {
            return (200, r#"{"took":3,"errors":false,"items":[]}"#.into());
        }
        if hit.path.contains("/_search") {
            return (200, devices(*knob.lock().unwrap()).to_string());
        }
        (200, r#"{"cluster_name":"test","status":"green"}"#.into())
    })
    .await
}

struct FakeSmtp {
    port: u16,
    mails: Arc<Mutex<Vec<String>>>,
}

async fn fake_smtp() -> FakeSmtp {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let mails: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = mails.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = l.accept().await else { break };
            let kept = kept.clone();
            tokio::spawn(async move {
                let (r, mut w) = sock.into_split();
                let mut r = BufReader::new(r);
                let _ = w.write_all(b"220 fake ESMTP\r\n").await;
                let mut line = String::new();
                loop {
                    line.clear();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let up = line.to_ascii_uppercase();
                    let reply: &[u8] = if up.starts_with("EHLO") {
                        b"250-fake\r\n250 8BITMIME\r\n"
                    } else if up.starts_with("DATA") {
                        let _ = w.write_all(b"354 go ahead\r\n").await;
                        let mut body = String::new();
                        loop {
                            let mut l = String::new();
                            if r.read_line(&mut l).await.unwrap_or(0) == 0 || l == ".\r\n" {
                                break;
                            }
                            body.push_str(&l);
                        }
                        kept.lock().unwrap().push(body);
                        b"250 queued\r\n"
                    } else if up.starts_with("QUIT") {
                        let _ = w.write_all(b"221 bye\r\n").await;
                        break;
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = w.write_all(reply).await;
                }
            });
        }
    });
    FakeSmtp { port, mails }
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": &s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn account(c: &Arc<Core>, admin: &str, name: &str, role: &str) -> String {
    let a = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role })).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    let l = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    l["session"].as_str().expect("a session").to_string()
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

#[tokio::test]
async fn the_built_in_destination_measures_tracks_periods_and_answers_every_read() {
    let dir = TempDir::new("logdelay-core");
    let knob: Knob = Arc::new(Mutex::new(45.0));
    let srv = cluster(knob.clone()).await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    let user = account(&c, &s, "uma", "user").await;
    let guest = account(&c, &s, "gus", "guest").await;
    let operator = account(&c, &s, "ollie", "operator").await;
    // readOnly: a sink cluster would be refused; the built-in store needs no write at all.
    let p = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": srv.url() }] })).await;
    assert_eq!(p["ok"], json!(true), "{p}");

    // Settings: the defaults, the resolved fields per cluster, who may change them.
    let g = c.handle(json!({ "type": "LOGDELAY_SETTINGS_GET", "session": &s })).await;
    assert_eq!(g["ok"], json!(true), "{g}");
    assert_eq!(g["settings"]["levels"], json!({ "noDelayUnder": 30.0, "delayFrom": 30.0, "criticalOver": 60.0 }));
    assert_eq!(g["settings"]["silentAfterHours"], json!(2));
    assert_eq!(g["resolved"][0]["id"], json!("prod"));
    assert!(g["resolved"][0]["fields"]["extras"].as_array().unwrap().contains(&json!("fwd_tag")), "{g}");
    assert_eq!(g["resolved"][0]["fields"]["device"], json!("src_hostname.keyword"));
    assert!(g["uiCopy"].as_str().unwrap().contains("log-delay.js"));
    let op = c.handle(json!({ "type": "LOGDELAY_SETTINGS_SET", "session": &operator, "settings": { "silentAfterHours": 3 } })).await;
    assert_eq!(op["kind"], json!("forbidden"), "an operator cannot change the levels: {op}");
    let op_get = c.handle(json!({ "type": "LOGDELAY_SETTINGS_GET", "session": &operator })).await;
    assert_eq!(op_get["kind"], json!("forbidden"), "nor read the settings page: {op_get}");
    let bad = c.handle(json!({ "type": "LOGDELAY_SETTINGS_SET", "session": &s, "settings": { "fields": { "device": "src host" } } })).await;
    assert_eq!(bad["kind"], json!("bad_request"), "{bad}");
    let set = c.handle(json!({ "type": "LOGDELAY_SETTINGS_SET", "session": &s,
                               "settings": { "silentAfterHours": 3, "clusters": { "prod": { "levels": { "delayFrom": 40 } } } } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["settings"]["silentAfterHours"], json!(3));
    assert_eq!(set["resolved"][0]["levels"]["delayFrom"], json!(40.0));
    assert_eq!(set["resolved"][0]["levelsFrom"], json!("settings"));
    // Back to the default line for the runs below.
    let reset = c.handle(json!({ "type": "LOGDELAY_SETTINGS_SET", "session": &s, "settings": { "clusters": {} } })).await;
    assert_eq!(reset["resolved"][0]["levelsFrom"], json!("default"), "{reset}");

    // Arm for the built-in store and run three times: open, continue, solve.
    let armed = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": true, "destination": "builtin", "everyHours": 2 } })).await;
    assert_eq!(armed["ok"], json!(true), "{armed}");
    assert_eq!(armed["blocked"], Value::Null, "{armed}");
    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(true), "{run}");
    assert_eq!((run["measured"].as_u64(), run["opened"].as_u64(), run["solved"].as_u64()), (Some(3), Some(1), Some(0)), "{run}");
    assert_eq!(run["destination"], json!("builtin"));
    *knob.lock().unwrap() = 94.0;
    let run2 = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!((run2["opened"].as_u64(), run2["solved"].as_u64()), (Some(0), Some(0)), "{run2}");
    *knob.lock().unwrap() = 5.0;
    let run3 = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run3["solved"], json!(1), "{run3}");
    let hits = srv.hits();
    assert_eq!(hits.iter().filter(|h| h.path.contains("/_search")).count(), 3, "one search per run");
    assert!(hits.iter().all(|h| h.method == "POST" && h.path.contains("/_search") || h.method == "GET"), "nothing written to the cluster: {:?}",
            hits.iter().map(|h| format!("{} {}", h.method, h.path)).collect::<Vec<_>>());
    let search = &hits.iter().find(|h| h.path.contains("/_search")).unwrap().body;
    assert!(search.contains("\"fwd_tag\"") && search.contains("\"Zone\""), "the extras are asked for: {search}");
    assert!(dir.join("logdelay").join("prod").join("tracker.json").is_file());
    assert!(dir.join("logdelay").join("findings.json").is_file());

    // The fleet summary, as a user.
    let sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &user })).await;
    assert_eq!(sum["ok"], json!(true), "{sum}");
    assert_eq!(sum["totals"]["devices"], json!(3));
    assert_eq!(sum["totals"]["unmeasured"], json!(1), "app-3 has no event time: can't measure, not 0");
    assert_eq!(sum["totals"]["late"], json!(0));
    assert_eq!(sum["totals"]["onTime"], json!(2));
    assert_eq!(sum["reduced"][0], json!({ "hours": 2, "n": 1 }), "{}", sum["reduced"]);
    assert_eq!(sum["byCluster"][0]["id"], json!("prod"));
    assert_eq!(sum["devices"][0]["device"], json!("fw-1"), "sorted by time late");
    assert_eq!(sum["devices"][0]["episodes"], json!(1));
    assert_eq!(sum["devices"][0]["maxMinutes"], json!(94.0));
    assert_eq!(sum["schedule"]["enabled"], json!(true));
    assert!(!sum["days"].as_array().unwrap().is_empty(), "{}", sum["days"]);
    let guest_sum = c.handle(json!({ "type": "LOGDELAY_SUMMARY", "session": &guest })).await;
    assert_eq!(guest_sum["kind"], json!("forbidden"), "{guest_sum}");
    let anon = c.handle(json!({ "type": "LOGDELAY_SUMMARY" })).await;
    assert_eq!(anon["kind"], json!("unauthenticated"), "{anon}");

    // One cluster, one device, the search, the fixes.
    let cl = c.handle(json!({ "type": "LOGDELAY_CLUSTER", "session": &user, "clusterId": "prod" })).await;
    assert_eq!(cl["ok"], json!(true), "{cl}");
    assert_eq!((cl["started"].as_u64(), cl["solved"].as_u64()), (Some(1), Some(1)));
    assert_eq!(cl["devices"].as_array().unwrap().len(), 3);
    assert_eq!(cl["fields"]["arrival"], json!("@timestamp"));
    let dev = c.handle(json!({ "type": "LOGDELAY_DEVICE", "session": &user, "clusterId": "prod", "device": "fw-1" })).await;
    assert_eq!(dev["ok"], json!(true), "{dev}");
    assert_eq!(dev["periods"].as_array().unwrap().len(), 1);
    assert_eq!(dev["periods"][0]["worstMinutes"], json!(94.0));
    assert_eq!(dev["periods"][0]["worstState"], json!("critical"));
    assert!(dev["periods"][0]["solved"].is_i64());
    assert_eq!(dev["insights"]["solvedIn"]["solved"], json!(1));
    assert_eq!(dev["extras"]["fwd_tag"], json!("syslog-dc1-02"));
    assert_eq!(dev["points"].as_array().unwrap().len(), 3);
    assert_eq!(dev["clusters"][0]["id"], json!("prod"));
    let none = c.handle(json!({ "type": "LOGDELAY_DEVICE", "session": &user, "clusterId": "prod", "device": "nope" })).await;
    assert_eq!(none["kind"], json!("not_found"));
    let by_zone = c.handle(json!({ "type": "LOGDELAY_SEARCH", "session": &user, "field": "Zone", "value": "dc?" })).await;
    assert_eq!(by_zone["matches"], json!(3), "{by_zone}");
    let by_name = c.handle(json!({ "type": "LOGDELAY_SEARCH", "session": &user, "name": "FW-1" })).await;
    assert_eq!(by_name["matches"], json!(1), "{by_name}");
    let by_host = c.handle(json!({ "type": "LOGDELAY_SEARCH", "session": &user, "field": "src_hostname", "value": "fw-*", "from": "2020-01-01" })).await;
    assert_eq!(by_host["kind"], json!("bad_request"), "a 2020 start is over 1200 days: {by_host}");
    let empty = c.handle(json!({ "type": "LOGDELAY_SEARCH", "session": &user })).await;
    assert_eq!(empty["kind"], json!("bad_request"));
    let fixes = c.handle(json!({ "type": "LOGDELAY_FIXES", "session": &user })).await;
    assert_eq!(fixes["ok"], json!(true), "{fixes}");
    assert_eq!(fixes["rules"].as_array().unwrap().len(), 8);
    let findings = fixes["findings"].as_array().unwrap();
    assert!(!findings.is_empty(), "one late device: a finding, if only not enough evidence: {fixes}");
    assert!(findings.iter().all(|f| f["devices"].as_array().unwrap().contains(&json!("fw-1"))), "{fixes}");
    assert_eq!(fixes["devices"][0]["device"], json!("fw-1"));
    assert!(fixes["devices"][0]["why"].as_str().unwrap().len() > 10);
}

#[tokio::test]
async fn the_log_delay_report_kind_builds_mails_and_keeps_its_options() {
    let dir = TempDir::new("logdelay-report");
    let knob: Knob = Arc::new(Mutex::new(70.0));
    let srv = cluster(knob.clone()).await;
    let smtp = fake_smtp().await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;
    let p = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": srv.url() }] })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    let armed = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": { "enabled": true, "destination": "builtin", "everyHours": 2 } })).await;
    assert_eq!(armed["ok"], json!(true), "{armed}");
    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["opened"], json!(1), "{run}");

    // The schedule: daily at 07:00 over yesterday, with options; a bad option is named.
    let sched = c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "session": &s, "kind": "log_delay" })).await;
    assert_eq!(sched["ok"], json!(true), "{sched}");
    assert_eq!((sched["schedule"].as_str(), sched["at"].as_str(), sched["period"].as_str()), (Some("daily"), Some("07:00"), Some("yesterday")));
    assert_eq!(sched["options"]["devices"], json!("delayed"));
    assert_eq!(sched["options"]["groupBy"], json!("cluster"));
    assert!(sched["optionsChoices"]["groupBy"].as_array().unwrap().contains(&json!("fwd_tag")), "{sched}");
    assert!(sched["optionsChoices"]["pdf"].as_str().unwrap().contains("not built"));
    let odd = c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "session": &s, "kind": "log_delay", "options": { "columns": ["device", "nope"] } })).await;
    assert_eq!(odd["kind"], json!("bad_request"), "{odd}");
    let set = c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "session": &s, "kind": "log_delay", "to": ["noc@example.com"],
                               "options": { "groupBy": "Zone", "devices": "all", "columns": ["device", "cluster", "nowMinutes", "level", "Zone", "fwd_tag"] } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["options"]["groupBy"], json!("Zone"));
    assert_eq!(set["options"]["devices"], json!("all"));
    let other = c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "session": &s, "kind": "indices", "options": { "devices": "all" } })).await;
    assert_eq!(other["kind"], json!("bad_request"), "options belong to the log delay kind only: {other}");

    // The mail server, then a run that mails.
    let mail = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "session": &s, "host": "127.0.0.1", "port": smtp.port, "security": "none", "auth": "none", "from": "ElasticPro <ep@example.com>" })).await;
    assert_eq!(mail["ok"], json!(true), "{mail}");
    let r = c.handle(json!({ "type": "REPORT_RUN", "session": &s, "kind": "log_delay", "clusterIds": ["prod"], "period": "last7", "mail": true,
                             "options": { "devices": "delayed" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let id = r["jobs"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(r["jobs"][0]["report"], json!("log_delay"));
    let job = ended(&c, &s, &id).await;
    assert_eq!(job["status"], json!("done"), "{job}");
    assert_eq!(job["mailError"], Value::Null, "{job}");
    assert!(job["file"]["name"].as_str().unwrap().ends_with(".xlsx"), "{job}");
    let dl = c.handle(json!({ "type": "REPORT_DOWNLOAD", "session": &s, "id": &id })).await;
    assert_eq!(dl["ok"], json!(true), "{dl}");
    let bytes = base64::engine::general_purpose::STANDARD.decode(dl["base64"].as_str().unwrap()).unwrap();
    let parts = elasticpro_core::report::zip::read(&bytes).unwrap();
    let wb = std::str::from_utf8(&parts.iter().find(|(n, _)| n == "xl/workbook.xml").unwrap().1).unwrap().to_string();
    for name in ["Summary", "Devices", "Every 2 hours", "Day by day", "Top delayed", "Fixes"] {
        assert!(wb.contains(&format!("name=\"{name}\"")), "{name} sheet missing: {wb}");
    }
    let mails = smtp.mails.lock().unwrap();
    assert_eq!(mails.len(), 1, "one mail");
    let m = &mails[0];
    assert!(m.contains("multipart/alternative"), "text and HTML: {m}");
    assert!(m.contains("text/html"), "{m}");
    assert!(m.contains("elasticpro-log-delay-") && m.contains("-devices.csv"), "the workbook and the CSV are attached: {m}");
    assert!(m.contains("1 devices late, 1 critical"), "the subject carries the headline: {m}");
}

#[tokio::test]
async fn a_limited_admin_sees_only_their_clusters_in_the_settings_and_the_summary() {
    use elasticpro_core::auth::{Caller, Role};
    let dir = TempDir::new("logdelay-limited");
    let knob: Knob = Arc::new(Mutex::new(45.0));
    let srv = cluster(knob.clone()).await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let root = Caller { name: "root".into(), role: Role::Admin, must_change: false, scope: None, play: None };
    // Two clusters, each in its own Zabbix group.
    let p = c.handle_as(json!({ "type": "PRIME", "readOnly": true, "clusters": [
        { "id": "one", "name": "One", "url": srv.url(), "zabbixGroups": ["ES one"] },
        { "id": "two", "name": "Two", "url": srv.url(), "zabbixGroups": ["ES two"] } ] }), Some(root.clone())).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    let set = c.handle_as(json!({ "type": "LOGDELAY_SETTINGS_SET", "settings": { "clusters": {
        "one": { "levels": { "delayFrom": 40 } }, "two": { "levels": { "delayFrom": 50 } } } } }), Some(root.clone())).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    let sched = c.handle_as(json!({ "type": "DELAY_SINK_SET", "config": { "enabled": true, "destination": "builtin", "clusters": ["one", "two"] } }), Some(root.clone())).await;
    assert_eq!(sched["ok"], json!(true), "{sched}");
    let run = c.handle_as(json!({ "type": "DELAY_SINK_RUN" }), Some(root.clone())).await;
    assert_eq!(run["clusters"], json!(2), "{run}");

    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["ES one".into()]), play: None };
    let g = c.handle_as(json!({ "type": "LOGDELAY_SETTINGS_GET" }), Some(limited.clone())).await;
    assert_eq!(g["ok"], json!(true), "{g}");
    assert_eq!(g["resolved"].as_array().unwrap().len(), 1, "{g}");
    assert_eq!(g["resolved"][0]["id"], json!("one"));
    assert_eq!(g["settings"]["clusters"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["one"], "the other cluster's override is not shown: {g}");
    assert_eq!(g["schedule"]["clusters"], json!(["one"]), "{g}");
    assert!(g["builtinStore"]["sizes"]["dayFiles"].as_u64().unwrap() >= 2, "{g}");
    let refused = c.handle_as(json!({ "type": "LOGDELAY_SETTINGS_SET", "settings": { "silentAfterHours": 4 } }), Some(limited.clone())).await;
    assert_eq!(refused["kind"], json!("forbidden"), "{refused}");
    let whole = c.handle_as(json!({ "type": "LOGDELAY_SETTINGS_GET" }), Some(root.clone())).await;
    assert_eq!(whole["settings"]["clusters"].as_object().unwrap().len(), 2, "the file itself keeps both");
    let sum = c.handle_as(json!({ "type": "LOGDELAY_SUMMARY" }), Some(limited.clone())).await;
    assert_eq!(sum["byCluster"].as_array().unwrap().len(), 1, "{sum}");
    assert_eq!(sum["totals"]["devices"], json!(3));
    let fixes = c.handle_as(json!({ "type": "LOGDELAY_FIXES" }), Some(limited.clone())).await;
    assert!(fixes["matchedAt"].is_i64(), "served from the run's findings: {fixes}");
    assert!(fixes["findings"].as_array().unwrap().iter().all(|f| f["cluster"] == "one"), "{fixes}");
    // The device page's "Delay by cluster" panel: the caller's clusters only, from daily.json.
    let dev = c.handle_as(json!({ "type": "LOGDELAY_DEVICE", "clusterId": "one", "device": "fw-1" }), Some(limited)).await;
    assert_eq!(dev["ok"], json!(true), "{dev}");
    let panel = dev["clusters"].as_array().unwrap();
    assert_eq!(panel.len(), 1, "{dev}");
    assert_eq!(panel[0]["id"], json!("one"));
    assert_eq!(panel[0]["lateNow"], json!(1), "fw-1 at 45 min over cluster one's 40: {dev}");
    assert!(panel[0]["lateAsOf"].is_string() && panel[0]["sparkline"].is_array(), "{dev}");
    let other = c.handle_as(json!({ "type": "LOGDELAY_DEVICE", "clusterId": "two", "device": "fw-1" }),
                            Some(Caller { name: "x".into(), role: Role::User, must_change: false, scope: Some(vec!["ES one".into()]), play: None })).await;
    assert_eq!(other["kind"], json!("not_found"), "a cluster outside the scope does not exist for the caller: {other}");
}

#[tokio::test]
async fn a_limited_admin_reads_nothing_of_a_cluster_outside_their_view_in_any_schedule_answer() {
    use elasticpro_core::auth::{Caller, Role};
    use std::sync::atomic::{AtomicBool, Ordering};
    const HIDDEN: &str = "secret-c3";
    const HIDDEN_NAME: &str = "Secret Three";
    let dir = TempDir::new("logdelay-lasterror");
    // Each cluster's search (and bulk) fails while its switch is on.
    let serve = |fail: Arc<AtomicBool>| TestServer::with(move |hit| {
        let failing = fail.load(Ordering::SeqCst);
        if hit.path.starts_with("/_bulk") {
            return if failing { (500, r#"{"error":"bulk refused"}"#.into()) } else { (200, r#"{"took":3,"errors":false,"items":[]}"#.into()) };
        }
        if hit.path.contains("/_search") {
            return if failing { (500, r#"{"error":"boom"}"#.into()) } else { (200, devices(2.0).to_string()) };
        }
        (200, r#"{"cluster_name":"test","status":"green"}"#.into())
    });
    let (two_fails, hidden_fails) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(true)));
    let (s1, s2, s3) = (serve(Arc::new(AtomicBool::new(false))).await, serve(two_fails.clone()).await, serve(hidden_fails.clone()).await);
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let root = Caller { name: "root".into(), role: Role::Admin, must_change: false, scope: None, play: None };
    let p = c.handle_as(json!({ "type": "PRIME", "readOnly": false, "clusters": [
        { "id": "one", "name": "One", "url": s1.url(), "zabbixGroups": ["ES one"] },
        { "id": "two", "name": "Two", "url": s2.url(), "zabbixGroups": ["ES two"] },
        { "id": HIDDEN, "name": HIDDEN_NAME, "url": s3.url(), "zabbixGroups": ["ES three"] } ] }), Some(root.clone())).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false,
                           scope: Some(vec!["ES one".into(), "ES two".into()]), play: None };
    // Every schedule answer a limited admin can ask for, as whole JSON text.
    let bodies = |who: Caller| {
        let c = c.clone();
        async move {
            let mut out = vec![];
            for t in ["DELAY_SINK_GET", "DELAY_SINK_RUN", "LOGDELAY_SETTINGS_GET", "LOGDELAY_SUMMARY"] {
                let v = c.handle_as(json!({ "type": t }), Some(who.clone())).await;
                assert!(v["state"].is_object() || v["schedule"].is_object(), "{t}: {v}");
                out.push((t, v.to_string()));
            }
            out
        }
    };
    let assert_clean = |bodies: &[(&str, String)]| {
        for (t, b) in bodies {
            assert!(!b.contains(HIDDEN) && !b.contains(HIDDEN_NAME), "{t} names the hidden cluster: {b}");
        }
    };

    // 1. A read error on the hidden cluster.
    let sched = c.handle_as(json!({ "type": "DELAY_SINK_SET", "config": { "enabled": true, "destination": "builtin", "clusters": ["one", "two", HIDDEN] } }), Some(root.clone())).await;
    assert_eq!(sched["ok"], json!(true), "{sched}");
    let run = c.handle_as(json!({ "type": "DELAY_SINK_RUN" }), Some(root.clone())).await;
    assert_eq!(run["failed"], json!(1), "{run}");
    assert!(run["error"].as_str().unwrap_or_default().starts_with(&format!("{HIDDEN}: ")), "a full admin reads it: {run}");
    let seen = bodies(limited.clone()).await;
    assert_clean(&seen);
    let get: Value = serde_json::from_str(&seen[0].1).unwrap();
    assert_eq!(get["config"]["clusters"], json!(["one", "two"]), "{get}");
    assert!(get["state"]["lastError"].as_str().unwrap_or_default().contains("outside your view"), "{get}");
    assert_eq!(get["state"]["lastOk"], json!(false), "still a failed run, not a fine one: {get}");
    let full = bodies(root.clone()).await;
    for (t, b) in &full {
        assert!(b.contains(&format!("{HIDDEN}: ")), "a full admin reads the error in {t}: {b}");
    }

    // 2. A read error on a cluster the limited admin sees is theirs to read.
    hidden_fails.store(false, Ordering::SeqCst);
    two_fails.store(true, Ordering::SeqCst);
    let run = c.handle_as(json!({ "type": "DELAY_SINK_RUN" }), Some(root.clone())).await;
    assert_eq!(run["failed"], json!(1), "{run}");
    let seen = bodies(limited.clone()).await;
    assert_clean(&seen);
    assert!(seen.iter().all(|(_, b)| b.contains("two: ")), "{seen:?}");
    two_fails.store(false, Ordering::SeqCst);

    // 3. Visible clusters written into a hidden sink cluster that refuses the bulk: the write
    //    error is about the sink, so it is hidden, and so is the sink's id in the config.
    hidden_fails.store(true, Ordering::SeqCst);
    let sched = c.handle_as(json!({ "type": "DELAY_SINK_SET", "config": { "enabled": true, "destination": "cluster", "sinkClusterId": HIDDEN, "clusters": ["one", "two"] } }), Some(root.clone())).await;
    assert_eq!(sched["ok"], json!(true), "{sched}");
    let run = c.handle_as(json!({ "type": "DELAY_SINK_RUN" }), Some(root.clone())).await;
    assert!(run["error"].as_str().unwrap_or_default().starts_with("one: "), "a write error, about cluster one: {run}");
    let seen = bodies(limited.clone()).await;
    assert_clean(&seen);
    assert!(seen.iter().all(|(_, b)| b.contains("outside your view")), "{seen:?}");
    let full = c.handle_as(json!({ "type": "DELAY_SINK_GET" }), Some(root)).await;
    assert_eq!(full["config"]["sinkClusterId"], json!(HIDDEN), "a full admin reads the config whole: {full}");
}
