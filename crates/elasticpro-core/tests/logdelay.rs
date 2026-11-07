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
    assert_eq!(g["settings"]["levels"], json!({ "noDelayUnder": 15.0, "delayFrom": 30.0, "criticalOver": 60.0 }));
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
    assert_eq!(fixes["rules"].as_array().unwrap().len(), 6);
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
