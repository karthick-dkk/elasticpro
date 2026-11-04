//! The report worker (docs/WORKER.md) assembled: a core in role `core` and one in role `worker`
//! on the same data directory, the worker's internal API served on loopback.
//!
//!   * actions go from the core to the worker with the shared token, and the core reads what
//!     the worker wrote (`jobs.json`, `worker/status.json`);
//!   * a worker that cannot be reached is `worker_unavailable`, and PING still answers;
//!   * a request with the wrong token or another version is refused (`worker_version`);
//!   * the core in role core never writes the queue, and only the worker marks a job a restart
//!     cut short;
//!   * the schedules' state moves out of report-schedule.json once, into its own file.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::worker::Role as ProcessRole;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn admin() -> Option<Caller> {
    Some(Caller { name: "admin".into(), role: Role::Admin, must_change: false, scope: None, play: None })
}

/// The worker's port as the bridge binary serves it, in a few lines of HTTP/1.1: one request
/// per connection, handed to `Core::worker_http`.
async fn serve_worker(worker: Arc<Core>) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            let w = worker.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|x| x == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let header = |k: &str| head.lines().find_map(|l| {
                    let (a, b) = l.split_once(':')?;
                    a.trim().eq_ignore_ascii_case(k).then(|| b.trim().to_string())
                });
                let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (code, out) = if path == "/health" {
                    (200, w.worker_health())
                } else {
                    w.worker_http(&path, header("x-elasticpro-worker-token").as_deref(), header("x-elasticpro-version").as_deref(),
                                  &buf[head_end..(head_end + len).min(buf.len())]).await
                };
                let body = out.to_string();
                let resp = format!("HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

async fn jobs_concurrency(core: &Arc<Core>, want: u64) -> Value {
    for _ in 0..100 {
        let r = core.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await;
        if r["concurrency"] == json!(want) {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the core never read concurrency {want} from jobs.json");
}

#[tokio::test]
async fn the_core_forwards_actions_and_reads_what_the_worker_wrote() {
    let dir = TempDir::new("worker-forward");
    let worker = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Worker);
    let core = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    assert_eq!(core.role(), ProcessRole::Core);
    assert!(!dir.join("worker").join("status.json").exists());
    let url = serve_worker(worker.clone()).await;
    core.set_worker_url_for_tests(&url);

    // An action: queued by the worker, read back by the core from jobs.json.
    let r = core.handle_as(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 4 }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = jobs_concurrency(&core, 4).await;
    assert_eq!(r["worker"]["state"], json!("missing"), "no heartbeat yet: {r}");

    // The heartbeat: the core sees the worker up.
    worker.worker_heartbeat(elasticpro_core::fleet::now_ms(), true);
    let st: Value = serde_json::from_slice(&std::fs::read(dir.join("worker").join("status.json")).unwrap()).unwrap();
    assert_eq!(st["role"], json!("worker"));
    assert_eq!(st["gate"]["label"], json!("worker"));
    assert_eq!(st["gate"]["perCluster"], json!(4), "the worker's own caps: {}", st["gate"]);
    let r = core.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await;
    assert_eq!(r["worker"]["state"], json!("up"), "{r}");

    // What the core can refuse itself never reaches the worker.
    let r = core.handle_as(json!({ "type": "REPORT_STOP", "id": "nope" }), admin()).await;
    assert_eq!(r["kind"], json!("not_found"), "{r}");
    let r = core.handle_as(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 9 }), admin()).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    let r = core.handle_as(json!({ "type": "REPORT_RUN", "kind": "hosts", "clusterIds": ["a", "b", "c", "d", "e", "f"] }), admin()).await;
    assert_eq!(r["kind"], json!("too_many_clusters"), "{r}");

    // VOLUME_RUN goes to the worker too (it answers for itself: no cluster is known there).
    let r = core.handle_as(json!({ "type": "VOLUME_RUN", "clusterIds": [] }), admin()).await;
    assert_ne!(r["kind"], json!("worker_unavailable"), "{r}");

    // The worker refuses a wrong token and another version.
    let token = std::fs::read_to_string(dir.join("worker").join("token")).unwrap();
    let body = json!({ "type": "REPORT_CONCURRENCY_SET", "msg": { "n": 3 }, "caller": { "name": "admin", "role": "admin" } }).to_string();
    let (code, _) = worker.worker_http("/queue", Some("wrong"), Some(elasticpro_core::VERSION), body.as_bytes()).await;
    assert_eq!(code, 401);
    let (code, v) = worker.worker_http("/queue", Some(token.trim()), Some("0.0.1"), body.as_bytes()).await;
    assert_eq!((code, v["kind"].clone()), (409, json!("worker_version")), "{v}");
    let (code, v) = worker.worker_http("/run", Some(token.trim()), Some(elasticpro_core::VERSION), body.as_bytes()).await;
    assert_eq!(code, 400, "REPORT_CONCURRENCY_SET is not taken at /run: {v}");

    // Worker down: the action is refused as worker_unavailable; monitoring still answers.
    core.set_worker_url_for_tests("http://127.0.0.1:1");
    let r = core.handle_as(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 5 }), admin()).await;
    assert_eq!(r["kind"], json!("worker_unavailable"), "{r}");
    assert_eq!(r["errorCode"], json!("EP-218"));
    assert!(r["lastHeartbeatAt"].as_u64().is_some(), "the last heartbeat is said: {r}");
    let p = core.handle_as(json!({ "type": "PING" }), admin()).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    // Reads never needed it.
    let r = core.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

/// A port that takes connections and never answers: a forward that reached it would wait out
/// the whole forward timeout. Counts the connections it took.
async fn silent_port() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n2 = n.clone();
    tokio::spawn(async move {
        let mut held = vec![];
        while let Ok((s, _)) = l.accept().await {
            n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            held.push(s);
        }
    });
    (format!("http://{addr}"), n)
}

#[tokio::test]
async fn a_worker_whose_heartbeat_is_late_is_not_asked_and_a_dead_address_costs_a_second_at_most() {
    let dir = TempDir::new("worker-late");
    let worker = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Worker);
    let core = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    let (url, taken) = silent_port().await;
    core.set_worker_url_for_tests(&url);
    let late = elasticpro_core::fleet::now_ms() - elasticpro_core::health::HEARTBEAT_AMBER_SECS * 1000 - 1_000;
    worker.worker_heartbeat(late, true);

    // Late heartbeat (the health check's amber line): answered at once, nothing sent.
    for t in [json!({ "type": "REPORT_CONCURRENCY_SET", "n": 4 }), json!({ "type": "VOLUME_RUN", "clusterIds": [] }),
              json!({ "type": "REPORT_CLEAR" })] {
        let started = std::time::Instant::now();
        let r = core.handle_as(t.clone(), admin()).await;
        let took = started.elapsed();
        assert_eq!(r["kind"], json!("worker_unavailable"), "{t}: {r}");
        assert_eq!(r["lastHeartbeatAt"], json!(late), "{r}");
        assert!(r["detail"].as_str().unwrap().contains("no heartbeat"), "{r}");
        assert!(took < std::time::Duration::from_millis(300), "{t} took {took:?}");
    }
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 0, "a late worker is never asked");

    // A fresh heartbeat: the worker is asked again.
    worker.worker_heartbeat(elasticpro_core::fleet::now_ms(), false);
    let ask = { let c = core.clone(); tokio::spawn(async move { c.handle_as(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 4 }), admin()).await }) };
    for _ in 0..100 {
        if taken.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 1, "a worker with a fresh heartbeat is asked");
    ask.abort();

    // An address nothing answers on (no route): the connect gives up within its second.
    core.set_worker_url_for_tests("http://10.255.255.1:8766");
    let started = std::time::Instant::now();
    let r = core.handle_as(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 4 }), admin()).await;
    let took = started.elapsed();
    assert_eq!(r["kind"], json!("worker_unavailable"), "{r}");
    assert!(took < std::time::Duration::from_millis(elasticpro_core::worker::CONNECT_TIMEOUT_MS + 1_500), "took {took:?}");
}

#[tokio::test]
async fn role_core_never_writes_the_queue_and_the_worker_marks_what_a_restart_cut_short() {
    let dir = TempDir::new("worker-queue");
    let reports = dir.join("reports");
    std::fs::create_dir_all(&reports).unwrap();
    let job = json!({ "id": "j1", "kind": "cluster", "clusterId": "a", "clusterIds": ["a"], "clusterName": "a",
                      "period": { "from": "2026-10-01", "to": "2026-10-01", "label": "x" }, "format": "xlsx", "mail": false,
                      "by": "ann", "status": "running", "createdAt": 1, "startedAt": 2, "seq": 1, "progress": { "done": 0, "total": 1 } });
    let text = json!({ "version": 1, "concurrency": 3, "jobs": [job], "nextSeq": 2 }).to_string();
    std::fs::write(reports.join("jobs.json"), &text).unwrap();

    let core = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    let r = core.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await;
    assert_eq!(r["jobs"][0]["status"], json!("running"), "the core shows the worker's queue as written: {r}");
    assert_eq!(std::fs::read_to_string(reports.join("jobs.json")).unwrap(), text, "role core wrote jobs.json");

    let worker = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Worker);
    drop(worker); // flushes the queue writer
    let after: Value = serde_json::from_slice(&std::fs::read(reports.join("jobs.json")).unwrap()).unwrap();
    assert_eq!(after["jobs"][0]["status"], json!("failed"), "{after}");
    let r = core.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await;
    assert_eq!(r["jobs"][0]["status"], json!("failed"), "and the core reads it: {r}");
    // The worker keeps no accounts and records no sign-in of its own.
    assert!(!dir.join("instance-worker.json").exists() || dir.join("instance.json").exists());
}

#[tokio::test]
async fn the_schedules_state_moves_to_its_own_file_once() {
    let dir = TempDir::new("worker-schedule");
    // As 0.3.53 left it: one schedule, its state inside.
    std::fs::write(dir.join("report-schedule.json"), json!({
        "enabled": false, "to": ["a@example.com"], "schedule": "monthly", "at": "07:30",
        "lastPeriod": "2026-09-01..2026-09-30", "lastSent": { "at": 5, "to": 1, "ok": true, "error": null },
    }).to_string()).unwrap();
    let core = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    let worker = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Worker);

    // Before the worker ran: the core shows the old fields, and a save keeps them for it.
    let g = core.handle_as(json!({ "type": "REPORT_SCHEDULE_GET" }), admin()).await;
    assert_eq!(g["lastSent"]["at"], json!(5), "{g}");
    let s = core.handle_as(json!({ "type": "REPORT_SCHEDULE_SET", "subject": "first" }), admin()).await;
    assert_eq!(s["ok"], json!(true), "{s}");
    let file: Value = serde_json::from_slice(&std::fs::read(dir.join("report-schedule.json")).unwrap()).unwrap();
    assert_eq!(file["volume"]["lastPeriod"], json!("2026-09-01..2026-09-30"), "not stripped before the state exists: {file}");
    assert!(!dir.join("report-schedule-state.json").exists(), "the core never writes the state");

    // The worker's first tick migrates it.
    let local = chrono::Local::now().naive_local();
    worker.report_tick_at(local).await;
    let state: Value = serde_json::from_slice(&std::fs::read(dir.join("report-schedule-state.json")).unwrap()).unwrap();
    assert_eq!(state["volume"]["lastPeriod"], json!("2026-09-01..2026-09-30"), "{state}");
    assert_eq!(state["volume"]["lastSent"]["at"], json!(5));

    // The next save writes settings only.
    let s = core.handle_as(json!({ "type": "REPORT_SCHEDULE_SET", "subject": "second" }), admin()).await;
    assert_eq!(s["ok"], json!(true), "{s}");
    let text = std::fs::read_to_string(dir.join("report-schedule.json")).unwrap();
    assert!(!text.contains("lastPeriod") && !text.contains("lastSent"), "{text}");
    assert!(text.contains("second"));
    let g = core.handle_as(json!({ "type": "REPORT_SCHEDULE_GET" }), admin()).await;
    assert_eq!(g["lastSent"]["at"], json!(5), "read from the state file: {g}");
    assert_eq!(g["subject"], json!("second"));
}
