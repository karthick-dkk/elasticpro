//! The job controls (docs/JOBS.md) through the real message API: run now (one run for two
//! presses), pause (the timer skips, the pause survives a restart, a run going finishes),
//! cancel (queued at once, running at its next safe point, the ask surviving a restart), retry
//! (limit and wait), created schedules (several per kind, the built-in one untouched),
//! duplicates joining, background reads shared only within their identity, busy clusters
//! deferring only themselves, stale worker runs, and who may do any of it.

mod support;

use chrono::{Duration, NaiveDate, NaiveDateTime, Utc};
use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::worker::Role as ProcessRole;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use support::{GaugedServer, Hit, TempDir};

const PASSWORD: &str = "correct-horse-battery";

fn hosted(dir: &TempDir) -> Arc<Core> {
    Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::All)
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": &s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn sign_in(c: &Arc<Core>, name: &str) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    res["session"].as_str().unwrap_or_else(|| panic!("a session: {res}")).to_string()
}

fn job<'a>(list: &'a Value, id: &str) -> &'a Value {
    list["jobs"].as_array().unwrap().iter().find(|j| j["id"] == json!(id)).unwrap_or_else(|| panic!("no job {id} in {list}"))
}

fn today() -> NaiveDate {
    Utc::now().date_naive()
}

fn local(d: NaiveDate, hhmm: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(&format!("{} {hhmm}", d.format("%Y-%m-%d")), "%Y-%m-%d %H:%M").unwrap()
}

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

/// The run log entry with this id, from JOBS_LIST.
async fn run_of(c: &Arc<Core>, s: Option<&str>, id: &str) -> Option<Value> {
    let mut m = json!({ "type": "JOBS_LIST", "limit": 200 });
    if let Some(s) = s {
        m["session"] = json!(s);
    }
    let l = c.handle(m).await;
    l["runs"].as_array().unwrap().iter().find(|r| r["id"] == json!(id)).cloned()
}

async fn ended_run(c: &Arc<Core>, s: Option<&str>, id: &str) -> Value {
    for _ in 0..400 {
        if let Some(r) = run_of(c, s, id).await {
            if !matches!(r["status"].as_str(), Some("running" | "queued")) {
                return r;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("run {id} did not end");
}

/// A cluster whose delay search takes `search_ms` and answers `status`; a bulk is taken at once.
async fn delay_cluster(search_ms: u64, status: u16) -> GaugedServer {
    GaugedServer::start(move |hit| {
        if hit.path.starts_with("/_bulk") {
            return (200, r#"{"took":3,"errors":false,"items":[{"index":{"status":201}}]}"#.into(), 0);
        }
        if status != 200 {
            return (status, r#"{"error":"boom"}"#.into(), search_ms);
        }
        let body = json!({ "took": 5, "aggregations": { "devices": { "buckets": [
            { "key": "fw-1", "doc_count": 120, "latest": { "hits": { "hits": [
                { "_source": { "@timestamp": "2026-09-19T12:41:00Z", "ingested_time": "2026-09-19T12:00:00Z" } },
            ] } } },
        ] } } });
        (200, body.to_string(), search_ms)
    })
    .await
}

async fn arm(c: &Arc<Core>, s: &str, url: &str, read_only: bool) {
    let res = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": read_only, "clusters": [
        { "id": "prod", "url": url }, { "id": "kibana", "url": url },
    ] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let res = c.handle(json!({ "type": "DELAY_SINK_SET", "session": s, "config": {
        "enabled": true, "destination": "cluster", "sinkClusterId": "kibana", "everyHours": 2,
        "indexPrefix": "elasticpro-log-delay", "indexPattern": "logstash-*" } })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
}

/// A volume cluster: `_cat` lists `days` daily indices; each day's search takes `search_ms`.
/// `throttled` answers 429 to everything while it is set.
async fn volume_cluster(days: i64, search_ms: u64, throttled: Arc<AtomicBool>) -> GaugedServer {
    let t = today();
    let names: Vec<String> = (1..=days).map(|d| format!("logstash-linux-{}", (t - Duration::days(d)).format("%Y.%m.%d"))).collect();
    GaugedServer::start(move |hit: &Hit| {
        if throttled.load(Ordering::SeqCst) {
            return (429, r#"{"error":"too many requests"}"#.into(), 0);
        }
        if hit.path.starts_with("/_cat/indices/") {
            let rows: Vec<Value> = names.iter().map(|n| json!({ "index": n, "status": "open", "docs.count": "10",
                "pri.store.size": "10", "store.size": "20" })).collect();
            return (200, Value::Array(rows).to_string(), 0);
        }
        if hit.path.contains("/_field_caps") {
            return (200, json!({ "indices": [], "fields": {
                "tag1": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
                "@timestamp": { "date": { "type": "date", "searchable": true, "aggregatable": true } },
            } }).to_string(), 0);
        }
        if let Some(s) = support::day_search(hit) {
            let buckets: Vec<Value> = s.dated.iter().map(|n| json!({ "key": n, "doc_count": 10, "sub": { "value": 1.0 }, "ev": { "value": 3.0 } })).collect();
            return (200, json!({ "hits": { "total": { "value": 10, "relation": "eq" } }, "aggregations": {
                "sub": { "value": 1.0 }, "ev": { "value": 3.0 },
                "by_index": { "sum_other_doc_count": 0, "buckets": buckets },
                "f_tag": { "sum_other_doc_count": 5, "buckets": [ { "key": "fw", "doc_count": 5, "sub": { "value": 1.0 } } ] },
                "m_tag": { "doc_count": 0, "sub": { "value": 0.0 } } } }).to_string(), search_ms);
        }
        if hit.path.contains("_search") {
            return (200, json!({ "hits": { "total": { "value": 0 } }, "aggregations": { "days": { "buckets": [] } } }).to_string(), 0);
        }
        (404, r#"{"error":"not here"}"#.into(), 0)
    })
    .await
}

async fn portable(dir: &TempDir, clusters: Vec<(&str, String)>) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let list: Vec<Value> = clusters.iter().map(|(id, url)| json!({ "id": id, "url": url })).collect();
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": list })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c
}

/* -------------------------------------------- run now -------------------------------------------- */

#[tokio::test]
async fn two_job_runs_start_one_run_and_the_old_button_is_the_same_run() {
    let dir = TempDir::new("jc-run-once");
    let srv = delay_cluster(1_200, 200).await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    arm(&c, &s, &srv.url(), false).await;

    let first = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" })).await;
    assert_eq!(first["ok"], json!(true), "{first}");
    let id = first["runId"].as_str().unwrap().to_string();
    let second = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" })).await;
    assert_eq!((second["kind"].clone(), second["runId"].clone()), (json!("already_running"), json!(id)), "{second}");
    // The page's own button (DELAY_SINK_RUN) meets the same run, once it is measuring.
    wait_for("the measurement at the cluster", || srv.holding() > 0).await;
    let old = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!((old["kind"].clone(), old["runId"].clone()), (json!("already_running"), json!(id)), "{old}");
    let r = ended_run(&c, Some(&s), &id).await;
    assert_eq!((r["status"].clone(), r["trigger"].clone()), (json!("completed"), json!("manual:Admin")), "{r}");
    let searches = srv.hits().iter().filter(|h| h.path.contains("/_search")).count();
    assert_eq!(searches, 1, "one measurement for three presses");

    // A job with nothing to start now says so; an unknown one is not found.
    let r = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "zabbix.push" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    let r = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "report.run" })).await;
    assert!(r["message"].as_str().unwrap().contains("JOB_CREATE"), "{r}");
    assert_eq!(c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "nope" })).await["kind"], json!("not_found"));

    // A manual backup (BACKUP_CREATE) is a run of the settings backup now, by its person.
    let b = c.handle(json!({ "type": "BACKUP_CREATE", "session": &s, "sections": ["clusters"] })).await;
    let list = c.handle(json!({ "type": "JOBS_LIST", "session": &s, "jobId": "settings.backup" })).await;
    let runs = list["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "{b} {list}");
    assert_eq!(runs[0]["trigger"], json!("manual:Admin"));
}

/* -------------------------------------------- pause -------------------------------------------- */

#[tokio::test]
async fn pause_skips_the_timer_survives_a_restart_and_a_running_run_finishes() {
    let t = today();
    let srv = volume_cluster(2, 400, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("jc-pause");
    {
        let c = portable(&dir, vec![("prod", srv.url())]).await;
        // A run going (Refresh now) when the pause comes: it finishes.
        let r = c.handle(json!({ "type": "VOLUME_RUN" })).await;
        let run = r["runId"].as_str().unwrap_or_else(|| panic!("Refresh now is a run of the daily job: {r}")).to_string();
        let p = c.handle(json!({ "type": "JOB_PAUSE", "jobId": "volume.daily" })).await;
        assert_eq!((p["ok"].clone(), p["paused"].clone()), (json!(true), json!(true)), "{p}");
        let done = ended_run(&c, None, &run).await;
        assert_eq!((done["status"].clone(), done["trigger"].clone()), (json!("completed"), json!("manual:local")), "{done}");
        // The timer starts nothing while paused, and records nothing.
        assert!(c.volume_tick_at(local(t + Duration::days(1), "06:00")).await.is_empty(), "paused: the timer skips");
        let l = c.handle(json!({ "type": "JOBS_LIST" })).await;
        let vd = job(&l, "volume.daily");
        assert_eq!((vd["state"]["paused"].clone(), vd["state"]["pausedBy"].clone()), (json!(true), json!("local")), "{vd}");
        assert!(vd["state"]["nextRunNote"].as_str().unwrap().contains("paused"), "{vd}");
        assert_eq!(l["runs"].as_array().unwrap().len(), 1, "a skipped tick is not a run: {l}");
        // Not every job pauses: a manual report run is cancelled instead.
        assert_eq!(c.handle(json!({ "type": "JOB_PAUSE", "jobId": "report.run" })).await["kind"], json!("bad_request"));
    }
    // The pause is in controls.json: a restart keeps it.
    assert!(dir.join("job-runs/controls.json").exists());
    let c = portable(&dir, vec![("prod", srv.url())]).await;
    assert!(c.volume_tick_at(local(t + Duration::days(1), "06:00")).await.is_empty(), "still paused after a restart");
    let g = c.handle(json!({ "type": "JOB_SETTINGS_GET" })).await;
    let vd = g["jobs"].as_array().unwrap().iter().find(|j| j["jobId"] == json!("volume.daily")).unwrap();
    assert_eq!(vd["paused"], json!(true), "{g}");
    let r = c.handle(json!({ "type": "JOB_RESUME", "jobId": "volume.daily" })).await;
    assert_eq!(r["paused"], json!(false), "{r}");
    assert_eq!(c.volume_tick_at(local(t + Duration::days(1), "06:00")).await, vec!["prod".to_string()], "resumed: the day's run starts");
}

/* -------------------------------------------- cancel -------------------------------------------- */

#[tokio::test]
async fn cancel_stops_a_running_collection_between_days() {
    let srv = volume_cluster(12, 300, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("jc-cancel");
    let c = portable(&dir, vec![("prod", srv.url())]).await;
    let r = c.handle(json!({ "type": "VOLUME_RUN" })).await;
    let run = r["runId"].as_str().unwrap().to_string();
    wait_for("the first day's search", || srv.hits().iter().any(|h| support::day_search(h).is_some())).await;
    let x = c.handle(json!({ "type": "JOB_CANCEL", "runId": &run })).await;
    assert_eq!((x["ok"].clone(), x["cancelAsked"].clone()), (json!(true), json!(true)), "{x}");
    let done = ended_run(&c, None, &run).await;
    assert_eq!(done["status"], json!("cancelled"), "{done}");
    assert!(done["note"].as_str().unwrap().contains("cancelled by local"), "{done}");
    let days = srv.hits().iter().filter(|h| support::day_search(h).is_some()).count();
    assert!(days < 12, "stopped between days, not after all twelve ({days})");
    let again = c.handle(json!({ "type": "JOB_CANCEL", "runId": &run })).await;
    assert_eq!(again["kind"], json!("bad_request"), "an ended run: {again}");
    assert_eq!(c.handle(json!({ "type": "JOB_CANCEL", "runId": "0123456789abcdef" })).await["kind"], json!("not_found"));
}

#[tokio::test]
async fn cancel_of_queued_and_running_report_jobs_and_the_ask_survives_a_restart() {
    // Three month-to-today jobs hold the three slots; a fourth waits and is cancelled at once.
    let srv = volume_cluster(9, 600, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("jc-cancel-report");
    let ids = ["a", "b", "c", "d"];
    let c = portable(&dir, ids.iter().map(|i| (*i, srv.url())).collect()).await;
    let day = |n: i64| (today() - Duration::days(n)).format("%Y-%m-%d").to_string();
    let period = json!({ "from": day(9), "to": day(0) });
    let mut runs = vec![];
    for id in ids {
        let r = c.handle(json!({ "type": "REPORT_RUN", "clusterIds": [id], "period": period, "format": "csvzip" })).await;
        runs.push(format!("report-{}", r["jobs"][0]["id"].as_str().unwrap_or_else(|| panic!("{r}"))));
    }
    let queued = runs[3].clone();
    let q = c.handle(json!({ "type": "JOB_CANCEL", "runId": &queued })).await;
    assert_eq!(q["status"], json!("cancelled"), "a queued run ends at once: {q}");
    let running = runs[0].clone();
    let r = c.handle(json!({ "type": "JOB_CANCEL", "runId": &running })).await;
    assert_eq!(r["cancelAsked"], json!(true), "{r}");
    // The ask is in jobs.json before the job reaches its next day.
    let l = c.handle(json!({ "type": "JOBS_LIST", "limit": 50 })).await;
    let mine = l["runs"].as_array().unwrap().iter().find(|x| x["id"] == json!(running)).unwrap().clone();
    assert_eq!(mine["cancelAsked"], json!(true), "{mine}");
    let done = ended_run(&c, None, &running).await;
    assert_eq!(done["status"], json!("cancelled"), "{done}");
    for r in &runs[1..3] {
        c.handle(json!({ "type": "JOB_CANCEL", "runId": r })).await;
    }

    // A restart while asked: the job ends cancelled, not failed.
    use elasticpro_core::report::jobs::{Format, Job, Kind, Queue, Status};
    let p = elasticpro_core::report::period::month_so_far(today());
    let mut j = Job::new(Kind::Cluster, vec!["a".into()], "a".into(), p, Format::Xlsx, false, "Admin", 1);
    j.status = Status::Running;
    j.stop_asked = Some("Admin".into());
    let mut queue = Queue::default();
    queue.push(j, "x1".into());
    let back: Queue = serde_json::from_str(&serde_json::to_string(&queue).unwrap()).unwrap();
    let mut back = back;
    assert!(back.restarted(5).is_empty(), "not failed");
    let x = back.get("x1").unwrap();
    assert_eq!((x.status, x.stopped_by.as_deref()), (Status::Stopped, Some("Admin")));
}

/* -------------------------------------------- retry -------------------------------------------- */

#[tokio::test]
async fn retry_keeps_to_its_limit_and_its_wait() {
    let dir = TempDir::new("jc-retry");
    let srv = delay_cluster(0, 500).await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    arm(&c, &s, &srv.url(), false).await;
    let first = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" })).await;
    let id = first["runId"].as_str().unwrap().to_string();
    let r = ended_run(&c, Some(&s), &id).await;
    assert_eq!(r["status"], json!("failed"), "{r}");
    // Within the wait (5 minutes by default): refused, with when.
    let w = c.handle(json!({ "type": "JOB_RETRY", "session": &s, "runId": &id })).await;
    assert_eq!(w["kind"], json!("retry_wait"), "{w}");
    assert!(w["retryAt"].as_u64().unwrap() > r["endedAt"].as_u64().unwrap());
    let set = c.handle(json!({ "type": "JOB_SETTINGS_SET", "session": &s, "overall": { "retryWaitMinutes": 0, "retryLimit": 1 } })).await;
    assert_eq!(set["overall"]["retryLimit"], json!(1), "{set}");
    let again = c.handle(json!({ "type": "JOB_RETRY", "session": &s, "runId": &id })).await;
    assert_eq!(again["ok"], json!(true), "{again}");
    let rid = again["runId"].as_str().unwrap().to_string();
    let rr = ended_run(&c, Some(&s), &rid).await;
    assert_eq!((rr["trigger"].clone(), rr["retryOf"].clone(), rr["attempt"].clone()), (json!("retry"), json!(id), json!(1)), "{rr}");
    // The limit: one retry, and this was it.
    let lim = c.handle(json!({ "type": "JOB_RETRY", "session": &s, "runId": &rid })).await;
    assert_eq!(lim["kind"], json!("retry_limit"), "{lim}");
    // Only a failed, deferred or cancelled run.
    let ok_srv = delay_cluster(0, 200).await;
    arm(&c, &s, &ok_srv.url(), false).await;
    let good = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" })).await;
    let gid = good["runId"].as_str().unwrap().to_string();
    assert_eq!(ended_run(&c, Some(&s), &gid).await["status"], json!("completed"));
    assert_eq!(c.handle(json!({ "type": "JOB_RETRY", "session": &s, "runId": &gid })).await["kind"], json!("bad_request"));
}

/* -------------------------------------------- create -------------------------------------------- */

#[tokio::test]
async fn several_created_schedules_per_kind_and_the_built_in_one_is_untouched() {
    let dir = TempDir::new("jc-create");
    let srv = volume_cluster(1, 0, Arc::new(AtomicBool::new(false))).await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    let r = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "url": srv.url() }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let builtin_before = c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "session": &s, "kind": "indices" })).await;
    let mut made = vec![];
    for (name, at) in [("Ops morning", "06:30"), ("Ops evening", "18:30")] {
        let r = c.handle(json!({ "type": "JOB_CREATE", "session": &s, "name": name, "report": "indices", "clusters": ["prod"],
                                 "schedule": "daily", "at": at, "to": ["ops@example.com"] })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
        assert!(r["jobId"].as_str().unwrap().starts_with("report.schedule."), "{r}");
        made.push(r["jobId"].as_str().unwrap().to_string());
    }
    assert_ne!(made[0], made[1], "each its own stable id");
    let dup = c.handle(json!({ "type": "JOB_CREATE", "session": &s, "name": "ops morning", "report": "indices", "clusters": ["prod"],
                               "schedule": "daily", "at": "07:00", "to": ["ops@example.com"] })).await;
    assert_eq!(dup["kind"], json!("name_taken"), "{dup}");
    let bad = c.handle(json!({ "type": "JOB_CREATE", "session": &s, "name": "x", "report": "indices", "clusters": ["nope"],
                               "schedule": "daily", "at": "07:00", "to": ["ops@example.com"] })).await;
    assert_eq!(bad["kind"], json!("bad_request"), "{bad}");

    let l = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    assert_eq!(l["jobs"].as_array().unwrap().len(), 15, "the registry's 13 and the two created");
    let one = job(&l, &made[0]);
    assert_eq!((one["report"].clone(), one["created"]["to"].clone()), (json!("indices"), json!(["ops@example.com"])), "{one}");
    assert!(one["state"]["nextRunAt"].is_i64(), "{one}");
    // The built-in schedule of the kind is not changed by them.
    let builtin_after = c.handle(json!({ "type": "REPORT_SCHEDULE_GET", "session": &s, "kind": "indices" })).await;
    for k in ["enabled", "to", "schedule", "at", "clusters", "managed"] {
        assert_eq!(builtin_before[k], builtin_after[k], "{k}");
    }
    assert!(!dir.join("report-schedule.json").exists(), "the built-in schedule's file was not written");
    assert!(dir.join("report-schedules-created.json").exists());

    // Tomorrow at 06:30 the first one is due: a job of its own, mapped to its own job id.
    let tomorrow = today() + Duration::days(1);
    let queued = c.report_tick_at(local(tomorrow, "06:31")).await.expect("the created schedule is due");
    let l = c.handle(json!({ "type": "JOBS_LIST", "session": &s, "jobId": made[0] })).await;
    let runs = l["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "{l}");
    assert_eq!((runs[0]["id"].clone(), runs[0]["trigger"].clone()), (json!(format!("report-{queued}")), json!("timer")));
    assert_eq!(c.report_tick_at(local(tomorrow, "06:32")).await, None, "once a period");
    // Paused, the evening one does not go; deleted, it is gone.
    c.handle(json!({ "type": "JOB_PAUSE", "session": &s, "jobId": made[1] })).await;
    assert_eq!(c.report_tick_at(local(tomorrow, "18:31")).await, None, "paused");
    assert_eq!(c.handle(json!({ "type": "JOB_DELETE", "session": &s, "jobId": made[1] })).await["deleted"], json!(true));
    assert_eq!(c.handle(json!({ "type": "JOB_DELETE", "session": &s, "jobId": "volume.daily" })).await["kind"], json!("bad_request"));
    let l = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    assert_eq!(l["jobs"].as_array().unwrap().len(), 14);
    c.handle(json!({ "type": "REPORT_STOP", "session": &s, "all": true })).await;
}

/* -------------------------------------------- duplicates -------------------------------------------- */

#[tokio::test]
async fn the_same_report_asked_again_joins_the_one_queued_or_running() {
    let srv = volume_cluster(6, 400, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("jc-dup");
    let c = portable(&dir, vec![("prod", srv.url())]).await;
    let day = |n: i64| (today() - Duration::days(n)).format("%Y-%m-%d").to_string();
    let ask = json!({ "type": "JOB_CREATE", "report": "volume", "once": true, "clusterIds": ["prod"],
                      "period": { "from": day(5), "to": day(0) }, "format": "csvzip" });
    let a = c.handle(ask.clone()).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    let first = a["runIds"][0].as_str().unwrap().to_string();
    let b = c.handle(ask.clone()).await;
    assert_eq!(b["joined"], json!([first]), "{b}");
    assert_eq!(b["runIds"], json!([first]), "{b}");
    // Another format is another file: queued apart.
    let mut other = ask.clone();
    other["format"] = json!("xlsx");
    let o = c.handle(other).await;
    assert_ne!(o["runIds"][0], json!(first), "{o}");
    let jobs = c.handle(json!({ "type": "REPORT_JOBS" })).await;
    assert_eq!(jobs["jobs"].as_array().unwrap().len(), 2, "{jobs}");
    c.handle(json!({ "type": "REPORT_STOP", "all": true })).await;
}

#[tokio::test]
async fn a_duplicate_joins_only_the_same_persons_job() {
    let srv = volume_cluster(6, 400, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("jc-dup-people");
    let c = hosted(&dir);
    let s = admin(&c).await;
    let r = c.handle(json!({ "type": "PRIME", "session": &s, "readOnly": true, "clusters": [{ "id": "prod", "url": srv.url() }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    for name in ["ann", "bob"] {
        let r = c.handle(json!({ "type": "USER_ADD", "session": &s, "name": name, "password": PASSWORD, "role": "user" })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
    }
    let (ann, bob) = (sign_in(&c, "ann").await, sign_in(&c, "bob").await);
    let day = |n: i64| (today() - Duration::days(n)).format("%Y-%m-%d").to_string();
    let ask = |who: &str| json!({ "type": "REPORT_RUN", "session": who, "clusterIds": ["prod"], "period": { "from": day(5), "to": day(0) }, "format": "csvzip" });
    let a1 = c.handle(ask(&ann)).await;
    let first = a1["jobs"][0]["id"].as_str().unwrap_or_else(|| panic!("{a1}")).to_string();
    let a2 = c.handle(ask(&ann)).await;
    assert_eq!(a2["joined"], json!([format!("report-{first}")]), "the same person, the same report: joined — {a2}");
    let b1 = c.handle(ask(&bob)).await;
    assert!(b1.get("joined").is_none(), "another person gets a job of their own: {b1}");
    let theirs = b1["jobs"][0]["id"].as_str().unwrap().to_string();
    assert_ne!(theirs, first);
    // And no rights over the other's: bob cannot download ann's report.
    let d = c.handle(json!({ "type": "REPORT_DOWNLOAD", "session": &bob, "id": first })).await;
    assert_eq!(d["kind"], json!("forbidden"), "{d}");
    c.handle(json!({ "type": "REPORT_STOP", "session": &s, "all": true })).await;
}

#[tokio::test]
async fn identical_background_reads_share_one_answer_and_never_across_people() {
    use elasticpro_core::gate::Class;
    use elasticpro_core::http::EsRequest;
    let srv = GaugedServer::start(|_| (200, r#"{"ok":1}"#.into(), 400)).await;
    let dir = TempDir::new("jc-share");
    let c = portable(&dir, vec![("prod", srv.url())]).await;
    let req = |user: Option<&str>, class: Class| EsRequest {
        cluster_id: "prod".into(), method: "GET".into(), path: "/_cat/thread_pool/search".into(), class,
        user: user.map(String::from), origin: Some("test".into()), ..EsRequest::default()
    };
    let before = srv.hits().len();
    let (x, y) = tokio::join!(c.es_req_as(req(None, Class::Background)), c.es_req_as(req(None, Class::Background)));
    assert_eq!((x["ok"].clone(), y["ok"].clone()), (json!(true), json!(true)));
    assert_eq!(srv.hits().len() - before, 1, "two identical background reads: one request");
    assert_eq!(y["shared"].as_bool().or(x["shared"].as_bool()), Some(true), "one of them joined");
    // Done for two different people: never shared.
    let before = srv.hits().len();
    let _ = tokio::join!(c.es_req_as(req(Some("ann"), Class::Background)), c.es_req_as(req(Some("bob"), Class::Background)));
    assert_eq!(srv.hits().len() - before, 2);
    // A person's read never joins background work.
    let before = srv.hits().len();
    let _ = tokio::join!(c.es_req_as(req(None, Class::Background)), c.es_req_as(req(Some("ann"), Class::Interactive)));
    assert_eq!(srv.hits().len() - before, 2);
}

/* -------------------------------------------- busy -------------------------------------------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_cluster_defers_only_itself_and_resumes_when_it_eases() {
    let t = today();
    let throttled = Arc::new(AtomicBool::new(true));
    let busy = volume_cluster(1, 0, throttled.clone()).await;
    let calm = volume_cluster(1, 0, Arc::new(AtomicBool::new(false))).await;
    let dir = TempDir::new("jc-busy");
    let c = portable(&dir, vec![("busy", busy.url()), ("calm", calm.url())]).await;
    let mut started = c.volume_tick_at(local(t, "06:00")).await;
    started.sort();
    assert_eq!(started, vec!["busy".to_string(), "calm".to_string()]);
    // busy answers 429: its part is deferred and its day given back; calm completes.
    let list = loop {
        let l = c.handle(json!({ "type": "JOBS_LIST" })).await;
        if job(&l, "volume.daily")["state"]["current"].is_null() {
            break l;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };
    let run = &job(&list, "volume.daily")["state"]["lastRun"];
    assert_eq!(run["status"], json!("deferred"), "{run}");
    assert!(run["error"].as_str().unwrap().contains("busy"), "{run}");
    let b = list["busy"].as_array().unwrap();
    assert_eq!(b.len(), 1, "{list}");
    assert_eq!((b[0]["cluster"].clone(), b[0]["signal"].clone()), (json!("busy"), json!("429")));
    assert!(b[0]["since"].is_u64());
    let daily = c.handle(json!({ "type": "VOLUME_DAILY", "clusterId": "calm" })).await;
    assert!(daily["status"]["lastError"].is_null(), "calm carried on: {daily}");

    // Still busy: the next tick leaves it, adding no record a tick.
    let n_runs = list["runs"].as_array().unwrap().len();
    assert!(c.volume_tick_at(local(t, "06:01")).await.is_empty(), "busy waits; calm is done for the day");
    assert!(c.volume_tick_at(local(t, "06:02")).await.is_empty());
    let l = c.handle(json!({ "type": "JOBS_LIST" })).await;
    assert_eq!(l["runs"].as_array().unwrap().len(), n_runs, "one record for the wait: {l}");
    // A person's own request is never held back: it goes.
    let before = busy.hits().len();
    c.handle(json!({ "type": "ES", "clusterId": "busy", "method": "GET", "path": "/_cat/indices/x?format=json" })).await;
    assert_eq!(busy.hits().len(), before + 1);

    // It eases: the first tick collects it.
    throttled.store(false, Ordering::SeqCst);
    c.load_clear_for_tests("busy");
    assert_eq!(c.volume_tick_at(local(t, "06:03")).await, vec!["busy".to_string()]);
    wait_for("the busy cluster's run", || busy.hits().iter().any(|h| support::day_search(h).is_some())).await;
}

/* -------------------------------------------- stale -------------------------------------------- */

#[tokio::test]
async fn a_worker_run_while_the_heartbeat_is_late_is_stale() {
    let dir = TempDir::new("jc-stale");
    std::fs::create_dir_all(dir.join("job-runs")).unwrap();
    std::fs::write(dir.join("job-runs/worker.json"), json!({ "version": 1, "runs": [
        { "id": "w1", "jobId": "volume.daily", "trigger": "timer", "status": "running", "createdAt": 10, "startedAt": 10,
          "endedAt": null, "clusters": [] },
    ] }).to_string()).unwrap();
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    let s = admin(&c).await;
    let l = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    assert_eq!(l["runs"][0]["stale"], json!(true), "no heartbeat: {l}");
    assert_eq!(job(&l, "volume.daily")["state"]["current"]["stale"], json!(true));
    let st = elasticpro_core::health::WorkerStatus {
        schema: elasticpro_core::health::WORKER_STATUS_SCHEMA, role: "worker".into(), version: elasticpro_core::VERSION.into(),
        heartbeat_at: elasticpro_core::fleet::now_ms(), ..Default::default()
    };
    st.write(&dir.0).unwrap();
    let l = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    assert_eq!(l["runs"][0]["stale"], json!(false), "{l}");
}

/* -------------------------------------------- who -------------------------------------------- */

#[tokio::test]
async fn only_an_administrator_of_every_cluster_controls_jobs_and_writes_go_through_the_guard() {
    let dir = TempDir::new("jc-authz");
    let srv = delay_cluster(0, 200).await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    for (name, role) in [("guest1", "guest"), ("user1", "user"), ("op1", "operator")] {
        let r = c.handle(json!({ "type": "USER_ADD", "session": &s, "name": name, "password": PASSWORD, "role": role })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
    }
    let writes = [
        json!({ "type": "JOB_RUN", "jobId": "housekeeping" }), json!({ "type": "JOB_PAUSE", "jobId": "housekeeping" }),
        json!({ "type": "JOB_RESUME", "jobId": "housekeeping" }), json!({ "type": "JOB_CANCEL", "runId": "x" }),
        json!({ "type": "JOB_RETRY", "runId": "x" }), json!({ "type": "JOB_SETTINGS_SET", "overall": { "mostAtOnce": 2 } }),
        json!({ "type": "JOB_CREATE", "once": true, "report": "volume" }), json!({ "type": "JOB_DELETE", "jobId": "report.schedule.ab" }),
    ];
    for name in ["guest1", "user1", "op1"] {
        let who = sign_in(&c, name).await;
        for w in &writes {
            let mut m = w.clone();
            m["session"] = json!(who);
            assert_eq!(c.handle(m.clone()).await["kind"], json!("forbidden"), "{name}: {m}");
        }
        assert_eq!(c.handle(json!({ "type": "JOB_SETTINGS_GET", "session": who })).await["kind"], json!("forbidden"));
    }
    // An administrator limited to some clusters: refused every change, may read the settings.
    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["ES one".into()]), play: None };
    for w in &writes {
        let r = c.handle_as(w.clone(), Some(limited.clone())).await;
        assert_eq!(r["kind"], json!("forbidden"), "{w}: {r}");
    }
    assert_eq!(c.handle_as(json!({ "type": "JOB_SETTINGS_GET" }), Some(limited)).await["ok"], json!(true));

    // The one job that writes to a cluster: refused by Writes::decide while the config is
    // read-only — the session's write unlock does not reach a background run.
    arm(&c, &s, &srv.url(), true).await;
    let u = c.handle(json!({ "type": "WRITE_UNLOCK", "session": &s, "on": true })).await;
    assert_eq!(u["ok"], json!(true), "{u}");
    let r = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" })).await;
    assert_eq!(r["kind"], json!("blocked_readonly"), "{r}");
    assert!(!srv.hits().iter().any(|h| h.path.contains("_search") || h.path.contains("_bulk")), "nothing was measured or written");
    // Writable: it runs.
    arm(&c, &s, &srv.url(), false).await;
    let r = c.handle(json!({ "type": "JOB_RUN", "session": &s, "jobId": "logdelay.measure" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    ended_run(&c, Some(&s), r["runId"].as_str().unwrap()).await;
}
