//! Volume reports and mail through the real message API, against a fake cluster and a fake
//! SMTP server on loopback (plain, no authentication).
//!
//! `report/*.rs` prove each rule on its own (the queue, the periods, the schedule, the
//! writers, the mail settings). These prove what only exists assembled:
//!
//!   * a job collects the period's days through the volume collector (origin
//!     `volume-report` in the request log), builds an .xlsx that opens, mails it, and
//!     `REPORT_DOWNLOAD` hands back the same file;
//!   * the CSV bundle has the contract's columns;
//!   * `MAIL_TEST` reports its steps; the password is never in a reply or on disk in clear,
//!     and the desktop refuses to store one at all;
//!   * on hosted, stopping jobs is an admin's, clearing removes only the caller's own,
//!     a download is the starter's — and the mailed schedule sends once per period, a
//!     restart included.

mod support;

use base64::Engine as _;
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Utc};
use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{TempDir, TestServer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn today() -> NaiveDate {
    Utc::now().date_naive()
}
fn dot(d: NaiveDate) -> String {
    d.format("%Y.%m.%d").to_string()
}

/// A cluster with a few day indices; documents per index are its primary size.
async fn cluster() -> TestServer {
    let t = today();
    let listing: Vec<(String, u64)> = vec![
        (format!("logstash-linux-{}", dot(t - Duration::days(1))), 200),
        (format!("logstash-win-{}", dot(t - Duration::days(1))), 100),
        (format!("logstash-linux-{}", dot(t - Duration::days(2))), 400),
        (format!("logstash-linux-{}", dot(t - Duration::days(3))), 100),
    ];
    TestServer::with(move |hit| {
        if hit.path.starts_with("/_cat/indices/") {
            let rows: Vec<Value> = listing.iter().map(|(n, pri)| json!({
                "index": n, "status": "open", "docs.count": pri.to_string(),
                "pri.store.size": pri.to_string(), "store.size": (pri * 2).to_string(),
            })).collect();
            return (200, Value::Array(rows).to_string());
        }
        if hit.path.contains("/_field_caps") {
            return (200, json!({ "indices": [], "fields": {
                "tag1": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
                "event_logsize": { "long": { "type": "long", "searchable": true, "aggregatable": true } },
            } }).to_string());
        }
        if let Some(rest) = hit.path.strip_prefix("/logstash-*-") {
            let day = rest.split('/').next().unwrap_or("");
            let mine: Vec<&(String, u64)> = listing.iter().filter(|(n, _)| n.ends_with(day)).collect();
            let docs: u64 = mine.iter().map(|(_, p)| *p).sum();
            let buckets: Vec<Value> = mine.iter().map(|(n, p)| json!({ "key": n, "doc_count": p, "ev": { "value": (*p * 3) as f64 } })).collect();
            return (200, json!({ "hits": { "total": { "value": docs, "relation": "eq" } }, "aggregations": {
                "ev": { "value": (docs * 3) as f64 },
                "by_index": { "sum_other_doc_count": 0, "buckets": buckets },
                "f_tag": { "sum_other_doc_count": docs - docs / 2, "buckets": [ { "key": "fw&<co>", "doc_count": docs / 2, "ev": { "value": 1.0 } } ] },
                "m_tag": { "doc_count": 0, "ev": { "value": 0.0 } },
            } }).to_string());
        }
        (404, r#"{"error":"not here"}"#.into())
    })
    .await
}

/// An SMTP server that accepts everything, offers no STARTTLS and no AUTH, and keeps what
/// it was sent.
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
                    } else if up.starts_with("MAIL") || up.starts_with("RCPT") || up.starts_with("RSET") || up.starts_with("NOOP") || up.starts_with("HELO") {
                        b"250 ok\r\n"
                    } else {
                        b"502 not here\r\n"
                    };
                    let _ = w.write_all(reply).await;
                }
            });
        }
    });
    FakeSmtp { port, mails }
}

fn with_session(mut m: Value, s: Option<&str>) -> Value {
    if let Some(s) = s {
        m["session"] = json!(s);
    }
    m
}

/// Wait for a job to end, through the list the page reads.
async fn ended(c: &Arc<Core>, s: Option<&str>, id: &str) -> Value {
    for _ in 0..400 {
        let r = c.handle(with_session(json!({ "type": "REPORT_JOBS" }), s)).await;
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

fn part<'a>(parts: &'a [(String, Vec<u8>)], name: &str) -> &'a str {
    std::str::from_utf8(&parts.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no {name}")).1).unwrap()
}

#[tokio::test]
async fn a_job_collects_builds_mails_and_hands_back_the_file() {
    let es = cluster().await;
    let smtp = fake_smtp().await;
    let dir = TempDir::new("report-job");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let p = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "prod", "name": "Production", "url": es.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");

    // The mail server: plain, no authentication. A password is refused on the desktop.
    let set = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "host": "127.0.0.1", "port": smtp.port, "security": "none",
                               "auth": "none", "from": "ElasticPro <ep@example.com>" })).await;
    assert_eq!(set["ok"], true, "{set}");
    assert_eq!((set["configured"].as_bool(), set["passwordSet"].as_bool()), (Some(true), Some(false)));
    assert_eq!(set["canStorePassword"], false);
    let pw = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "auth": "password", "user": "svc", "password": "hunter2" })).await;
    assert_eq!(pw["kind"], "cannot_store_password", "{pw}");
    let none_pw = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "auth": "password", "user": "svc" })).await;
    assert_eq!(none_pw["kind"], "bad_request", "security none with a password is refused: {none_pw}");
    assert!(!std::fs::read_to_string(dir.join("mail.json")).unwrap().contains("hunter2"));

    // The test mail, step by step.
    let t = c.handle(json!({ "type": "MAIL_TEST", "to": "ops@example.com" })).await;
    assert_eq!(t["ok"], true, "{t}");
    let steps: Vec<&str> = t["steps"].as_array().unwrap().iter().map(|s| s["step"].as_str().unwrap()).collect();
    assert_eq!(steps, ["connect", "tls", "auth", "send"]);
    assert!(t["steps"].as_array().unwrap().iter().all(|s| s["ok"] == true));
    assert_eq!(smtp.mails.lock().unwrap().len(), 1);

    // No recipients yet: the job still ends done, with the reason it was not mailed.
    let r = c.handle(json!({ "type": "REPORT_RUN", "clusterIds": ["prod", "nope"], "period": "last7", "format": "xlsx", "mail": true })).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["jobs"].as_array().unwrap().len(), 1, "one job per known cluster");
    assert_eq!(r["refused"], json!([{ "clusterId": "nope", "reason": "unknown" }]));
    let j = &r["jobs"][0];
    assert_eq!((j["clusterId"].as_str(), j["clusterName"].as_str(), j["format"].as_str()), (Some("prod"), Some("Production"), Some("xlsx")));
    assert_eq!(j["period"]["from"], (today() - Duration::days(7)).format("%Y-%m-%d").to_string());
    let first = ended(&c, None, j["id"].as_str().unwrap()).await;
    assert_eq!(first["status"], "done", "{first}");
    assert!(first["mailError"].as_str().unwrap().contains("no recipients"), "{first}");

    // Recipients, then the real thing.
    let s = c.handle(json!({ "type": "REPORT_SCHEDULE_SET", "to": ["ops@example.com"], "bcc": ["audit@example.com"] })).await;
    assert_eq!(s["ok"], true, "{s}");
    let r = c.handle(json!({ "type": "REPORT_RUN", "clusterIds": ["prod"], "period": "last7", "format": "xlsx", "mail": true })).await;
    let id = r["jobs"][0]["id"].as_str().unwrap().to_string();
    let job = ended(&c, None, &id).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["mailError"], Value::Null, "{job}");
    assert_eq!(job["progress"]["done"], job["progress"]["total"]);
    let name = format!("volume-prod-{}_{}.xlsx", (today() - Duration::days(7)).format("%Y-%m-%d"), (today() - Duration::days(1)).format("%Y-%m-%d"));
    assert_eq!(job["file"]["name"], name.as_str());

    // The collector ran under its report origin.
    let searches: Vec<_> = es.hits().into_iter().filter(|h| h.path.contains("/_search")).collect();
    assert!(!searches.is_empty());
    assert!(searches.iter().any(|h| h.header("x-opaque-id").is_some_and(|v| v.contains("volume-report"))), "origin volume-report");

    // The mail carried the workbook and the summary; bcc is not in the headers.
    let mails = smtp.mails.lock().unwrap().clone();
    assert_eq!(mails.len(), 2, "the test mail and this job's; the first job had nobody to send to");
    let m = mails.last().unwrap();
    assert!(m.contains(&name), "the attachment is named: {m}");
    assert!(m.contains("Production (primary size)") && m.contains("Yesterday"), "the summary per cluster: {m}");
    assert!(!m.contains("audit@example.com"));

    // REPORT_DOWNLOAD hands back a workbook that opens.
    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "id": id })).await;
    assert_eq!(d["ok"], true, "{d}");
    assert_eq!(d["name"], name.as_str());
    assert_eq!(d["mime"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    let parts = unzip(d["base64"].as_str().unwrap());
    let wb = part(&parts, "xl/workbook.xml");
    for s in ["Daily", "Monthly", "Breakdown"] {
        assert!(wb.contains(&format!("name=\"{s}\"")), "{wb}");
    }
    let daily = part(&parts, "xl/worksheets/sheet1.xml");
    assert!(daily.contains("Primary size (bytes)") && daily.contains("Primary size GB"), "{daily}");
    assert!(daily.contains((today() - Duration::days(1)).format("%Y-%m-%d").to_string().as_str()));
    let breakdown = part(&parts, "xl/worksheets/sheet3.xml");
    assert!(breakdown.contains("fw&amp;&lt;co&gt;"), "a field value from the cluster is escaped: {breakdown}");
    assert!(breakdown.contains("est."));

    // The CSV bundle.
    let r = c.handle(json!({ "type": "REPORT_RUN", "clusterIds": ["prod"], "period": { "from": (today() - Duration::days(3)).format("%Y-%m-%d").to_string(), "to": (today() - Duration::days(1)).format("%Y-%m-%d").to_string() }, "format": "csvzip" })).await;
    let cid = r["jobs"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(ended(&c, None, &cid).await["status"], "done");
    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "id": cid })).await;
    assert_eq!(d["mime"], "application/zip");
    let parts = unzip(d["base64"].as_str().unwrap());
    let csv = part(&parts, "daily.csv");
    assert!(csv.starts_with("cluster,day,indices,docs,primary_bytes,total_bytes,event_bytes,event_bytes_measured,sub_bytes,change_vs_avg_pct,avg_days\n"), "{csv}");
    assert_eq!(csv.lines().count(), 4, "three days: {csv}");
    assert!(part(&parts, "breakdown.csv").contains("prod,tag,tag1,fw&<co>,"));
    assert!(part(&parts, "monthly.csv").starts_with("cluster,month,days_with_data,"));

    // Bad requests say what is wrong.
    for bad in [
        json!({ "type": "REPORT_RUN", "period": "last7" }),
        json!({ "type": "REPORT_RUN", "clusterIds": ["prod"], "period": "month:2099-01" }),
        json!({ "type": "REPORT_RUN", "clusterIds": ["prod"], "period": "last7", "format": "pdf" }),
        json!({ "type": "REPORT_CONCURRENCY_SET", "n": 9 }),
    ] {
        assert_eq!(c.handle(bad.clone()).await["kind"], "bad_request", "{bad}");
    }
    assert_eq!(c.handle(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 5 })).await["concurrency"], 5);

    // Files are kept 0600 under reports/; clearing removes them with the jobs.
    let f = dir.join("reports").join(format!("{id}-{name}"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let cl = c.handle(json!({ "type": "REPORT_CLEAR" })).await;
    assert_eq!(cl["removed"], 3);
    assert!(!f.exists());
    assert_eq!(c.handle(json!({ "type": "REPORT_JOBS" })).await["jobs"], json!([]));
}

const PASSWORD: &str = "correct-horse-battery";

async fn login(c: &Arc<Core>, name: &str) -> String {
    let l = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    l["session"].as_str().unwrap_or_else(|| panic!("{l}")).to_string()
}

#[tokio::test]
async fn on_hosted_roles_ownership_the_stored_password_and_the_schedule() {
    let es = cluster().await;
    let smtp = fake_smtp().await;
    let dir = TempDir::new("report-hosted");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    for t in ["REPORT_RUN", "REPORT_JOBS", "REPORT_STOP", "REPORT_CLEAR", "REPORT_DOWNLOAD", "REPORT_CONCURRENCY_SET",
              "MAIL_SETTINGS_GET", "MAIL_SETTINGS_SET", "MAIL_TEST", "REPORT_SCHEDULE_GET", "REPORT_SCHEDULE_SET", "REPORT_SEND_NOW"] {
        assert_eq!(c.handle(json!({ "type": t })).await["kind"], "unauthenticated", "{t}");
    }
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let first = r["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": first, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], true, "{ch}");
    let admin = login(&c, "Admin").await;
    let p = c.handle(json!({ "type": "PRIME", "session": admin, "readOnly": true, "clusters": [{ "id": "prod", "url": es.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    for (name, role) in [("ursula", "user"), ("uma", "user"), ("otto", "operator")] {
        let a = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role })).await;
        assert_eq!(a["ok"], true, "{a}");
    }
    let (ursula, uma, otto) = (login(&c, "ursula").await, login(&c, "uma").await, login(&c, "otto").await);

    // Users run reports; the period's days are collected once and the files are theirs.
    let run = |s: &str| json!({ "type": "REPORT_RUN", "session": s, "clusterIds": ["prod"], "period": "yesterday", "format": "xlsx" });
    let a = c.handle(run(&ursula)).await;
    let ida = a["jobs"][0]["id"].as_str().unwrap().to_string();
    let b = c.handle(run(&uma)).await;
    let idb = b["jobs"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(ended(&c, Some(&ursula), &ida).await["status"], "done");
    assert_eq!(ended(&c, Some(&uma), &idb).await["status"], "done");
    let jobs = c.handle(json!({ "type": "REPORT_JOBS", "session": uma })).await;
    assert_eq!(jobs["jobs"].as_array().unwrap().len(), 2, "everyone sees the queue of the clusters they see: {jobs}");
    assert_eq!((jobs["concurrency"].as_u64(), jobs["running"].as_u64()), (Some(3), Some(0)));
    assert!(jobs["jobs"][0].get("volume").is_none());

    // Download: the starter's, or an admin's.
    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "session": uma, "id": ida })).await;
    assert_eq!(d["kind"], "forbidden", "{d}");
    assert_eq!(c.handle(json!({ "type": "REPORT_DOWNLOAD", "session": ursula, "id": ida })).await["ok"], true);
    assert_eq!(c.handle(json!({ "type": "REPORT_DOWNLOAD", "session": admin, "id": ida })).await["ok"], true);

    // Stop is an admin's; clear removes only the caller's own.
    for s in [&ursula, &otto] {
        let r = c.handle(json!({ "type": "REPORT_STOP", "session": s, "all": true })).await;
        assert_eq!(r["kind"], "forbidden", "{r}");
    }
    let st = c.handle(json!({ "type": "REPORT_STOP", "session": admin, "all": true })).await;
    assert_eq!(st["ok"], true, "{st}");
    assert_eq!(c.handle(json!({ "type": "REPORT_CLEAR", "session": ursula })).await["removed"], 1);
    let left = c.handle(json!({ "type": "REPORT_JOBS", "session": uma })).await;
    assert_eq!(left["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(left["jobs"][0]["id"], idb.as_str(), "uma's job is still there");

    // Mail settings are an admin's. On hosted the password is kept, sealed.
    assert_eq!(c.handle(json!({ "type": "MAIL_SETTINGS_GET", "session": otto })).await["kind"], "forbidden");
    let set = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "session": admin, "settings": {
        "host": "127.0.0.1", "port": smtp.port, "security": "starttls", "auth": "password", "user": "svc",
        "password": "s3cret-Pa55", "from": "ep@example.com" } })).await;
    assert_eq!(set["ok"], true, "{set}");
    assert_eq!((set["passwordSet"].as_bool(), set["canStorePassword"].as_bool()), (Some(true), Some(true)));
    let get = c.handle(json!({ "type": "MAIL_SETTINGS_GET", "session": admin })).await;
    assert!(!get.to_string().contains("s3cret-Pa55") && !get.to_string().contains("enc:v1"), "{get}");
    assert_eq!(get["passwordFrom"], "stored");
    let raw = std::fs::read_to_string(dir.join("mail.json")).unwrap();
    assert!(!raw.contains("s3cret-Pa55"), "sealed on disk");
    // STARTTLS is not offered by this server: the test says which step failed.
    let t = c.handle(json!({ "type": "MAIL_TEST", "session": admin, "to": "ops@example.com" })).await;
    assert_eq!((t["ok"].as_bool(), t["kind"].as_str()), (Some(false), Some("smtp_failed")), "{t}");
    let last = t["steps"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["step"].as_str(), last["ok"].as_bool()), (Some("tls"), Some(false)), "{t}");
    assert!(!t.to_string().contains("s3cret-Pa55"));
    // Plain again, without the password (kept, but not used without auth).
    let plain = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "session": admin, "security": "none", "auth": "none", "clearPassword": true })).await;
    assert_eq!((plain["ok"].as_bool(), plain["passwordSet"].as_bool()), (Some(true), Some(false)), "{plain}");

    // The schedule: an admin's; switched on mid-period it does not send that period late.
    let sch = json!({ "type": "REPORT_SCHEDULE_SET", "enabled": true, "to": ["ops@example.com"], "schedule": "monthly", "at": "07:00" });
    let mut as_user = sch.clone();
    as_user["session"] = json!(ursula);
    assert_eq!(c.handle(as_user).await["kind"], "forbidden");
    let mut as_admin = sch.clone();
    as_admin["session"] = json!(admin);
    let saved = c.handle(as_admin).await;
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(saved["timer"], true);
    assert!(saved["nextSendAt"].is_i64(), "{saved}");
    let now = chrono::Local::now().naive_local();
    if now.day() > 1 || now.format("%H:%M").to_string().as_str() >= "07:00" {
        assert_eq!(c.report_tick_at(now).await, None, "the month that has begun was handled when the schedule was saved");
    }
    // The 1st of next month, after 07:00: due, once.
    let (y, m) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    let first_of_next = NaiveDateTime::parse_from_str(&format!("{y:04}-{m:02}-01 08:00"), "%Y-%m-%d %H:%M").unwrap();
    let before = smtp.mails.lock().unwrap().len();
    let job = c.report_tick_at(first_of_next).await.expect("due on the 1st");
    let j = ended(&c, Some(&admin), &job).await;
    assert_eq!(j["status"], "done", "{j}");
    assert_eq!(j["mailError"], Value::Null, "{j}");
    assert_eq!(j["kind"], "mailed");
    assert_eq!(j["by"], "(schedule)");
    assert_eq!(smtp.mails.lock().unwrap().len(), before + 1);
    let mail = smtp.mails.lock().unwrap().last().unwrap().clone();
    assert!(mail.contains("ElasticPro volume report"), "{mail}");
    assert_eq!(c.report_tick_at(first_of_next + Duration::minutes(1)).await, None, "not again");
    let g = c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "session": admin })).await;
    assert_eq!((g["lastSent"]["ok"].as_bool(), g["lastSent"]["to"].as_u64()), (Some(true), Some(1)), "{g}");
    assert!(!g.to_string().contains("lastPeriod"));
    // A restart remembers.
    drop(c);
    let c2 = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let admin2 = login(&c2, "Admin").await;
    let p = c2.handle(json!({ "type": "PRIME", "session": admin2, "readOnly": true, "clusters": [{ "id": "prod", "url": es.url() }] })).await;
    assert_eq!(p["ok"], true, "{p}");
    assert_eq!(c2.report_tick_at(first_of_next + Duration::minutes(2)).await, None, "a restart does not resend");
}
