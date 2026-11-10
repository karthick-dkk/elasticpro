//! The governor (docs/JOBS.md "Governor") assembled: a core in role `core` and one in role
//! `worker` on one data directory.
//!
//!   * people waiting at the core's gate reach the worker through `core-load.json` and halve
//!     its total — and its own gate — at the next tick; JOBS_LIST in role core shows it from the
//!     worker's heartbeat, and nothing (null) when that heartbeat is missing;
//!   * a stale publication says nothing (not known), never "nobody waiting";
//!   * `REPORT_CONCURRENCY_SET` writes `mostAtOnce`, the one setting of jobs at once;
//!   * the core's gate limits change without a restart (`JOB_SETTINGS_SET overall.esConcurrency`);
//!   * the shape JOBS_LIST gives in role all, a job's allocation null while it does not run.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::worker::Role as ProcessRole;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::{GaugedServer, TempDir};

fn admin() -> Option<Caller> {
    Some(Caller { name: "admin".into(), role: Role::Admin, must_change: false, scope: None, play: None })
}

fn job<'a>(list: &'a Value, id: &str) -> &'a Value {
    list["jobs"].as_array().unwrap().iter().find(|j| j["id"] == json!(id)).unwrap_or_else(|| panic!("no job {id} in {list}"))
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn people_waiting_at_the_core_halve_the_worker_at_its_next_tick() {
    let dir = TempDir::new("gov-people");
    let core = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    let worker = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Worker);
    // No heartbeat yet: the core knows nothing of the worker's governor.
    let l = core.handle_as(json!({ "type": "JOBS_LIST" }), admin()).await;
    assert_eq!(l["governor"], Value::Null, "no worker heartbeat: not known, never a made-up figure: {l}");

    // A first tick before the core published anything: people not known, the total held at its
    // start (half of workerTotal) — never pushed harder on a guess.
    let v = worker.governor_tick_at(elasticpro_core::fleet::now_ms());
    assert_eq!(v["signals"]["peopleWaiting"], Value::Null, "the core has published nothing yet: not known");
    assert_eq!(v["total"], json!(8), "{v}");
    // Published, nobody waiting: calm, one more.
    core.core_load_publish(elasticpro_core::fleet::now_ms());
    let v = worker.governor_tick_at(elasticpro_core::fleet::now_ms());
    let calm_total = v["total"].as_u64().unwrap();
    assert_eq!((calm_total, v["lastChange"]["reason"].clone()), (9, json!("calm")), "{v}");

    // A slow cluster; one request at a time per cluster at the core's gate.
    let slow = GaugedServer::start(|_| (200, "{}".into(), 1_500)).await;
    let r = core.handle_as(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "slow", "url": slow.url() }] }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let mut cfg = core.request_config();
    cfg.limits.per_cluster = 1;
    core.set_request_config_for_tests(cfg);
    // Two people's requests to it: the second waits at the core's gate.
    // (Two paths: two identical reads would share one answer, docs/JOBS.md "Duplicates".)
    let asks: Vec<_> = (0..2).map(|i| {
        let c = core.clone();
        tokio::spawn(async move { c.handle_as(json!({ "type": "ES", "clusterId": "slow", "method": "GET", "path": format!("/_cluster/health?i={i}") }), admin()).await })
    }).collect();
    wait_for("a person waiting at the core's gate", || core.gate_counts().1 > 0).await;
    let now = elasticpro_core::fleet::now_ms();
    core.core_load_publish(now);
    assert!(dir.join("job-runs").join("core-load.json").exists());

    // The worker's next tick: halved, and its own gate with it.
    let v = worker.governor_tick_at(now + 10_000);
    assert_eq!(v["lastChange"]["reason"], json!("people_waiting"), "{v}");
    assert_eq!((v["lastChange"]["from"].as_u64(), v["total"].as_u64()), (Some(calm_total), Some(calm_total / 2)), "{v}");
    assert!(v["signals"]["peopleWaiting"].as_u64().unwrap() >= 1, "{v}");
    worker.worker_heartbeat(elasticpro_core::fleet::now_ms(), false);
    let st: Value = serde_json::from_slice(&std::fs::read(dir.join("worker").join("status.json")).unwrap()).unwrap();
    assert_eq!(st["gate"]["slots"], json!(calm_total / 2), "the worker's gate follows the total: {}", st["gate"]);

    // JOBS_LIST in role core: the worker's governor, from its heartbeat.
    let l = core.handle_as(json!({ "type": "JOBS_LIST" }), admin()).await;
    let g = &l["governor"];
    assert_eq!(g["total"], json!(calm_total / 2), "{g}");
    assert_eq!(g["lastChange"]["reason"], json!("people_waiting"));
    for k in ["auto", "inUse", "total", "mostAtOnce", "jobsRunning", "lastChange", "signals"] {
        assert!(g.get(k).is_some(), "governor.{k}: {g}");
    }
    for k in ["cpuPct", "memoryPct", "peopleWaiting", "queue", "avgPageMs"] {
        assert!(g["signals"].get(k).is_some(), "signals.{k}: {g}");
    }
    assert_eq!((g["mostAtOnce"].clone(), g["auto"].clone(), g["jobsRunning"].clone()), (json!(4), json!(true), json!(0)));
    assert!(g.get("allocations").is_none(), "allocations go to each job: {g}");
    assert_eq!(job(&l, "volume.daily")["state"]["allocation"], Value::Null, "not running: no allocation");

    for a in asks {
        let r = a.await.unwrap();
        assert_eq!(r["ok"], json!(true), "{r}");
    }
    // A publication older than CORE_LOAD_FRESH_MS says nothing: not known, never "nobody".
    let later = now + elasticpro_core::jobs::governor::CORE_LOAD_FRESH_MS + 1_000;
    let v = worker.governor_tick_at(later);
    assert_eq!(v["signals"]["peopleWaiting"], Value::Null, "{v}");
    assert_ne!(v["lastChange"]["reason"], json!("calm"), "not known never grows it: {v}");
    // Published again: nobody waits now, but one person did within the last ten seconds — that
    // still counts (`PEOPLE_WINDOW_MS`), and the total stays down.
    core.core_load_publish(elasticpro_core::fleet::now_ms());
    let before = v["total"].as_u64().unwrap();
    let v = worker.governor_tick_at(elasticpro_core::fleet::now_ms());
    assert_eq!(v["signals"]["peopleWaiting"], json!(1), "{v}");
    assert!(v["total"].as_u64().unwrap() <= before, "{v}");
}

#[tokio::test]
async fn one_setting_for_jobs_at_once_and_the_core_gate_changes_without_a_restart() {
    let dir = TempDir::new("gov-settings");
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::All);
    let r = c.handle_as(json!({ "type": "REPORT_CONCURRENCY_SET", "n": 5 }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let s = c.handle_as(json!({ "type": "JOB_SETTINGS_GET" }), admin()).await;
    assert_eq!(s["overall"]["mostAtOnce"], json!(5), "REPORT_CONCURRENCY_SET writes mostAtOnce: {s}");
    let r = c.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await;
    assert_eq!(r["concurrency"], json!(5));
    let r = c.handle_as(json!({ "type": "JOB_SETTINGS_SET", "overall": { "mostAtOnce": 2 } }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(c.handle_as(json!({ "type": "REPORT_JOBS" }), admin()).await["concurrency"], json!(2), "and back: one setting");

    // The core's gate: live.
    let before = c.request_config().limits;
    let r = c.handle_as(json!({ "type": "JOB_SETTINGS_SET", "overall": { "esConcurrency": 30, "esPerCluster": 3 } }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let l = c.request_config().limits;
    assert_eq!((l.global, l.per_cluster), (30, 3), "applied at once, no restart");
    assert_eq!(r["coreGate"]["esConcurrency"]["value"], json!(30), "{r}");
    assert_eq!(r["coreGate"]["esConcurrency"]["lockedBy"], Value::Null);
    let r = c.handle_as(json!({ "type": "JOB_SETTINGS_SET", "overall": { "esConcurrency": null, "esPerCluster": null } }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let l = c.request_config().limits;
    assert_eq!((l.global, l.per_cluster), (before.global, before.per_cluster), "null: config.txt's again");
    let r = c.handle_as(json!({ "type": "JOB_SETTINGS_SET", "overall": { "esConcurrency": 0 } }), admin()).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");

    // JOBS_LIST in role all: the governor of this process; nothing running, no allocation.
    let l = c.handle_as(json!({ "type": "JOBS_LIST" }), admin()).await;
    assert_eq!(l["governor"]["mostAtOnce"], json!(2), "{l}");
    assert!(l["governor"]["total"].as_u64().unwrap() >= 1);
    assert!(l["jobs"].as_array().unwrap().iter().all(|j| j["state"]["allocation"].is_null()), "{l}");
}

#[tokio::test]
async fn a_core_job_runs_in_a_lane_fixed_at_its_maximum() {
    let dir = TempDir::new("gov-core-job");
    let c = Core::new_for_role(Some(dir.0.clone()), Edition::Hosted, 1, ProcessRole::Core);
    let r = c.handle_as(json!({ "type": "JOB_SETTINGS_SET", "jobId": "logdelay.measure", "requests": { "max": 3 } }), admin()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let probe = c.governor_probe_for_tests("logdelay.measure").await;
    assert_eq!(probe, (true, 3), "fixed at the job's maximum: no AIMD in the core");
}
