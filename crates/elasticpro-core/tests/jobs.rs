//! Jobs (docs/JOBS.md) through the real message API: the registry and the run log as
//! `JOBS_LIST` answers them, one run per job at a time (a manual log delay run while one goes
//! is `already_running`, with that run's id — before, both ran and wrote the same hour twice),
//! the log surviving a restart, and the one-writer-per-file rule between core and worker.
//!
//! The log's own rules (the cap, progress, who reads what, the hosts tries) are proved in
//! `jobs/mod.rs`.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::worker::Role;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{GaugedServer, TempDir};

const PASSWORD: &str = "correct-horse-battery";

fn core(dir: &TempDir) -> Arc<Core> {
    Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, Role::All)
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

/// A cluster whose delay search takes `search_ms`; a bulk is taken at once.
async fn slow_cluster(search_ms: u64) -> GaugedServer {
    GaugedServer::start(move |hit| {
        if hit.path.starts_with("/_bulk") {
            return (200, r#"{"took":3,"errors":false,"items":[{"index":{"status":201}}]}"#.into(), 0);
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

async fn arm(c: &Arc<Core>, s: &str, url: &str) {
    let res = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": false, "clusters": [
        { "id": "prod", "url": url }, { "id": "kibana", "url": url },
    ] })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let res = c.handle(json!({ "type": "DELAY_SINK_SET", "session": s, "config": {
        "enabled": true, "destination": "cluster", "sinkClusterId": "kibana", "everyHours": 2,
        "indexPrefix": "elasticpro-log-delay", "indexPattern": "logstash-*" } })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
}

fn job<'a>(list: &'a Value, id: &str) -> &'a Value {
    list["jobs"].as_array().unwrap().iter().find(|j| j["id"] == json!(id)).unwrap_or_else(|| panic!("no job {id} in {list}"))
}

#[tokio::test]
async fn jobs_list_names_every_job_and_needs_a_user() {
    let dir = TempDir::new("jobs-list");
    let c = core(&dir);
    let s = admin(&c).await;
    assert_eq!(c.handle(json!({ "type": "JOBS_LIST" })).await["kind"], json!("unauthenticated"));
    let r = c.handle(json!({ "type": "USER_ADD", "session": &s, "name": "guest1", "password": PASSWORD, "role": "guest" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let g = sign_in(&c, "guest1").await;
    assert_eq!(c.handle(json!({ "type": "JOBS_LIST", "session": &g })).await["kind"], json!("forbidden"), "a guest's page is cluster health only");
    let r = c.handle(json!({ "type": "USER_ADD", "session": &s, "name": "user1", "password": PASSWORD, "role": "user" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let u = sign_in(&c, "user1").await;

    let list = c.handle(json!({ "type": "JOBS_LIST", "session": &u })).await;
    assert_eq!(list["ok"], json!(true), "{list}");
    assert_eq!(list["jobs"].as_array().unwrap().len(), 13, "{list}");
    assert_eq!(list["runs"], json!([]));
    assert_eq!(list["next"], Value::Null);
    let ld = job(&list, "logdelay.measure");
    assert_eq!((ld["priority"].clone(), ld["owner"].clone(), ld["pausable"].clone()), (json!("high"), json!("core"), json!(true)));
    assert_eq!(ld["state"]["enabled"], json!(true));
    assert_eq!(ld["state"]["paused"], json!(false));
    // Not armed: no time, and why — never a guessed time.
    assert_eq!(ld["state"]["nextRunAt"], Value::Null);
    assert!(ld["state"]["nextRunNote"].as_str().unwrap().contains("not armed"), "{ld}");
    assert_eq!(job(&list, "report.run")["state"]["nextRunNote"], json!("runs when a person asks"));
    assert_eq!(list["process"]["worker"]["state"], json!("not_deployed"), "role all has no worker");
    assert!(list["process"]["core"]["gate"]["queued"].is_u64(), "{list}");
    assert_eq!(c.handle(json!({ "type": "JOBS_LIST", "session": &u, "jobId": "nope" })).await["kind"], json!("bad_request"));
    assert_eq!(c.handle(json!({ "type": "JOBS_LIST", "session": &u, "before": "x" })).await["kind"], json!("bad_request"));
}

#[tokio::test]
async fn a_manual_delay_run_while_one_runs_is_already_running_with_its_id() {
    let dir = TempDir::new("jobs-overlap");
    let srv = slow_cluster(1_500).await;
    let c = core(&dir);
    let s = admin(&c).await;
    arm(&c, &s, &srv.url()).await;

    let (c1, s1) = (c.clone(), s.clone());
    let first = tokio::spawn(async move { c1.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s1 })).await });
    // Wait until the first run's search is at the cluster.
    for _ in 0..100 {
        if srv.holding() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(srv.holding(), 1, "the first run's search is under way");
    let busy = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(busy["ok"], json!(false), "{busy}");
    assert_eq!(busy["kind"], json!("already_running"), "{busy}");
    let open = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    let current = &job(&open, "logdelay.measure")["state"]["current"];
    assert_eq!(busy["runId"], current["id"], "the answer names the run that is going: {open}");
    assert_eq!(current["status"], json!("running"));
    assert_eq!(current["progress"], Value::Null, "a plain run counts nothing: progress is not known, not 0");

    let done = first.await.unwrap();
    assert_eq!(done["ok"], json!(true), "{done}");
    let searches = srv.hits().iter().filter(|h| h.path.contains("/_search")).count();
    assert_eq!(searches, 1, "the second press measured nothing");

    let list = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    let ld = job(&list, "logdelay.measure");
    assert_eq!(ld["state"]["current"], Value::Null);
    let last = &ld["state"]["lastRun"];
    assert_eq!(last["id"], busy["runId"]);
    assert_eq!(last["status"], json!("completed"), "{last}");
    assert_eq!(last["trigger"], json!("manual:Admin"));
    assert_eq!(last["records"], json!(1), "one device measured");
    assert_eq!(last["clusters"], json!(["prod", "kibana"]), "read from prod, written to kibana");
    assert!(ld["state"]["nextRunAt"].is_i64(), "armed: a time — {ld}");
    assert_eq!(list["runs"].as_array().unwrap().len(), 1, "the refused press is not a run: {list}");

    // A free job runs again at once.
    let again = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(again["ok"], json!(true), "{again}");
}

#[tokio::test]
async fn the_run_log_survives_a_restart_and_pages() {
    let dir = TempDir::new("jobs-restart");
    let srv = slow_cluster(0).await;
    let id = {
        let c = core(&dir);
        let s = admin(&c).await;
        arm(&c, &s, &srv.url()).await;
        for _ in 0..3 {
            assert_eq!(c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await["ok"], json!(true));
        }
        let hk = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": &s, "dryRun": true })).await;
        assert!(hk.get("run").is_some(), "{hk}");
        let list = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
        assert_eq!(list["runs"].as_array().unwrap().len(), 4, "{list}");
        let hk = job(&list, "housekeeping")["state"]["lastRun"].clone();
        assert_eq!((hk["status"].clone(), hk["trigger"].clone()), (json!("completed"), json!("manual:Admin")), "{hk}");
        c.jobs_flush_for_tests();
        list["runs"][0]["id"].clone()
    };
    // Written by the process that runs the core's jobs; no worker file in role all without one.
    assert!(dir.join("job-runs/core.json").exists());
    let c = core(&dir);
    let s = sign_in(&c, "Admin").await;
    let one = c.handle(json!({ "type": "JOBS_LIST", "session": &s, "limit": 3 })).await;
    assert_eq!(one["runs"][0]["id"], id, "the newest first, after a restart: {one}");
    assert_eq!(one["runs"].as_array().unwrap().len(), 3);
    let two = c.handle(json!({ "type": "JOBS_LIST", "session": &s, "limit": 3, "before": one["next"].clone() })).await;
    assert_eq!(two["runs"].as_array().unwrap().len(), 1, "{two}");
    assert_eq!(two["next"], Value::Null);
    let only = c.handle(json!({ "type": "JOBS_LIST", "session": &s, "jobId": "housekeeping" })).await;
    assert_eq!(only["runs"].as_array().unwrap().len(), 1, "{only}");
}

#[tokio::test]
async fn the_core_reads_the_workers_runs_and_jobs_but_writes_neither() {
    let dir = TempDir::new("jobs-split");
    // The worker's run file and queue, as the worker would have left them.
    std::fs::create_dir_all(dir.join("job-runs")).unwrap();
    std::fs::write(dir.join("job-runs/worker.json"), json!({ "version": 1, "runs": [
        { "id": "w1", "jobId": "volume.daily", "trigger": "timer", "status": "running", "createdAt": 10, "startedAt": 10,
          "endedAt": null, "done": 1, "total": 4, "records": 12, "error": null, "clusters": ["a", "b", "c", "d"] },
    ] }).to_string()).unwrap();
    std::fs::create_dir_all(dir.join("reports")).unwrap();
    std::fs::write(dir.join("reports/jobs.json"), json!({ "version": 1, "concurrency": 3, "nextSeq": 1, "jobs": [
        { "id": "abc123", "kind": "mailed", "clusterId": "a", "clusterName": "1 cluster", "clusterIds": ["a"],
          "period": { "from": "2026-11-01", "to": "2026-11-09", "label": "November" }, "format": "xlsx", "mail": true,
          "by": "(schedule)", "createdAt": 20, "startedAt": 21, "endedAt": 30, "status": "done",
          "progress": { "done": 9, "total": 9 }, "file": null, "error": null, "mailError": null, "stoppedBy": null, "seq": 1 },
    ] }).to_string()).unwrap();
    let before = std::fs::read(dir.join("job-runs/worker.json")).unwrap();

    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, Role::Core);
    let s = admin(&c).await;
    let list = c.handle(json!({ "type": "JOBS_LIST", "session": &s })).await;
    assert_eq!(list["role"], json!("core"));
    let vd = job(&list, "volume.daily");
    assert_eq!(vd["state"]["current"]["id"], json!("w1"), "{list}");
    assert_eq!(vd["state"]["current"]["owner"], json!("worker"));
    assert_eq!(vd["state"]["current"]["progress"], json!(25));
    let mailed = &job(&list, "report.mailed.volume")["state"]["lastRun"];
    assert_eq!(mailed["id"], json!("report-abc123"), "a report job is mapped from jobs.json: {list}");
    assert_eq!((mailed["status"].clone(), mailed["trigger"].clone()), (json!("completed"), json!("timer")));
    assert_eq!(list["process"]["worker"]["state"], json!("missing"), "no heartbeat yet: {list}");
    c.jobs_flush_for_tests();
    assert_eq!(std::fs::read(dir.join("job-runs/worker.json")).unwrap(), before, "the core never writes the worker's file");
}
