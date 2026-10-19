//! Housekeeping through the real message API and the real core.
//!
//! `housekeeping.rs` proves each job's rule in isolation on temp folders. These prove the
//! parts that only exist when it is assembled: that an admin — and only an admin — can ask
//! for it, that a run reaches the right stores, that a dry run changes nothing, that the
//! timer fires when the clock says so, and that each run leaves its one entry in the
//! activity log.

mod support;

use elasticpro_core::auth::{Edition, Role};
use elasticpro_core::housekeeping::{Config, RunRequest, Trigger, FIRST_RUN_DELAY_MS};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use support::{TempDir, TestServer};

const PASSWORD: &str = "correct-horse-battery";
const DAY: u64 = 86_400_000;

fn core(dir: &TempDir, edition: Edition) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), edition, 1)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

async fn admin_session(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn add_and_login(c: &Arc<Core>, admin: &str, name: &str, role: &str) -> String {
    let r = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    res["session"].as_str().expect("a session").to_string()
}

fn put(path: &Path, bytes: usize, age: Duration) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, vec![b'x'; bytes]).unwrap();
    std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(SystemTime::now() - age).unwrap();
}

const H: Duration = Duration::from_secs(3600);
const D: Duration = Duration::from_secs(86_400);

fn job<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["jobs"].as_array().unwrap().iter().find(|j| j["id"] == json!(id)).unwrap_or_else(|| panic!("no job {id} in {report}"))
}

async fn prime(c: &Arc<Core>, session: Option<&str>, ids: &[&str], url: &str) {
    let clusters: Vec<Value> = ids.iter().map(|id| json!({ "id": id, "url": url })).collect();
    let mut m = json!({ "type": "PRIME", "clusters": clusters });
    if let Some(s) = session {
        m["session"] = json!(s);
    }
    let r = c.handle(m).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

/* --------------------------------- who may ask --------------------------------- */

#[test]
fn the_role_table_makes_both_messages_admin_only() {
    for t in ["HOUSEKEEPING_GET", "HOUSEKEEPING_RUN"] {
        assert_eq!(elasticpro_core::auth::required_role(t), Some(Role::Admin), "{t}");
    }
}

#[tokio::test]
async fn only_an_admin_can_read_or_run_housekeeping_and_a_refusal_deletes_nothing() {
    let dir = TempDir::new("hk-gate");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    prime(&c, Some(&admin), &["c1"], "http://127.0.0.1:9").await;
    // Something a run would delete: a removed cluster's cache.
    let victim = dir.join("cache/gone/health.json");
    put(&victim, 10, H);

    let mut others = vec![];
    for role in ["operator", "user", "guest"] {
        others.push((role, add_and_login(&c, &admin, &format!("u-{role}"), role).await));
    }
    for (role, session) in &others {
        for t in ["HOUSEKEEPING_GET", "HOUSEKEEPING_RUN"] {
            let r = c.handle(json!({ "type": t, "session": session })).await;
            assert_eq!(r["ok"], json!(false), "{role} {t}: {r}");
            assert_eq!(r["kind"], json!("forbidden"), "{role} {t}: {r}");
        }
    }
    // No session at all.
    for t in ["HOUSEKEEPING_GET", "HOUSEKEEPING_RUN"] {
        let r = c.handle(json!({ "type": t })).await;
        assert_eq!(r["kind"], json!("unauthenticated"), "{t}: {r}");
    }
    // An API token is a machine with a role: a user-role token is no administrator either.
    let tok = c.handle(json!({ "type": "TOKEN_CREATE", "session": admin, "name": "robot", "role": "user" })).await;
    let secret = tok["secret"].as_str().unwrap().to_string();
    let caller = c.caller_for_token(&secret).expect("the token is live");
    let r = c.handle_as(json!({ "type": "HOUSEKEEPING_RUN" }), Some(caller)).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");
    assert!(victim.exists(), "nothing was deleted by a refused request");

    // The admin may.
    let g = c.handle(json!({ "type": "HOUSEKEEPING_GET", "session": admin })).await;
    assert_eq!(g["ok"], json!(true), "{g}");
    assert!(g["lastRun"].is_null(), "not run yet");
    let run = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(run["ok"], json!(true), "{run}");
    assert_eq!(run["run"]["trigger"], json!("manual"));
    assert_eq!(run["run"]["by"], json!("Admin"));
    assert!(!victim.exists(), "and it deleted the removed cluster's cache");
    // The status now remembers it.
    let g = c.handle(json!({ "type": "HOUSEKEEPING_GET", "session": admin })).await;
    assert_eq!(g["lastRun"]["items"], run["run"]["items"]);
    assert_eq!(g["recent"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn portable_has_no_roles_so_the_owner_may_run_it() {
    let dir = TempDir::new("hk-portable");
    let c = core(&dir, Edition::Portable);
    let g = c.handle(json!({ "type": "HOUSEKEEPING_GET" })).await;
    assert_eq!(g["ok"], json!(true), "{g}");
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "dryRun": true })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["run"]["by"], json!("local"));
    assert_eq!(job(&r["run"], "sessions")["skipped"], json!("this edition has no accounts and so no sessions"));
}

/* ----------------------------- the fleet disk cache ----------------------------- */

#[tokio::test]
async fn a_run_cleans_the_cache_and_a_dry_run_only_says_so() {
    let dir = TempDir::new("hk-cache");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    prime(&c, Some(&admin), &["c1"], "http://127.0.0.1:9").await;
    let stale = dir.join("cache/c1/indices.json.gz");
    let fresh = dir.join("cache/c1/health.json");
    let removed_cluster = dir.join("cache/gone/health.json");
    let tmp = dir.join("cache/c1/nodes.tmp");
    let foreign = dir.join("cache/c1/notes.json");
    put(&stale, 100, 3 * D);
    put(&fresh, 10, Duration::from_secs(60));
    put(&removed_cluster, 50, H);
    put(&tmp, 5, 2 * H);
    put(&foreign, 7, 90 * D);
    // Things housekeeping only reports.
    put(&dir.join("keys/id_ed25519"), 5, 400 * D);
    put(&dir.join("config-history/100-x.json"), 5, 100 * D);
    put(&dir.join("saved-queries.json"), 5, 100 * D);

    let dry = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin, "dryRun": true })).await;
    assert_eq!(dry["run"]["dryRun"], json!(true), "{dry}");
    let j = job(&dry["run"], "fleet-cache");
    assert_eq!((j["items"].as_u64(), j["bytes"].as_u64()), (Some(4), Some(155)), "stale + gone file + gone folder + tmp: {j}");
    assert!(stale.exists() && removed_cluster.exists() && tmp.exists(), "a dry run removes nothing");
    assert!(dry["message"].as_str().unwrap().starts_with("would remove"), "{dry}");

    let real = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(real["run"]["dryRun"], json!(false));
    assert_eq!(job(&real["run"], "fleet-cache")["items"], json!(4));
    assert!(!stale.exists() && !removed_cluster.exists() && !tmp.exists());
    assert!(!dir.join("cache/gone").exists(), "the emptied folder of a removed cluster goes with it");
    for kept in [&fresh, &foreign, &dir.join("keys/id_ed25519"), &dir.join("config-history/100-x.json"), &dir.join("saved-queries.json"), &dir.join("users.json")] {
        assert!(kept.exists(), "{} must survive", kept.display());
    }
    // And it says what it left alone, without deleting it.
    let ro = real["run"]["reportOnly"].as_array().unwrap();
    let keys = ro.iter().find(|r| r["id"] == json!("keys")).unwrap();
    assert_eq!((keys["files"].as_u64(), keys["oldestAgeDays"].as_u64()), (Some(1), Some(400)));
    // Clean now: nothing more to do.
    let again = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(job(&again["run"], "fleet-cache")["items"], json!(0));
}

#[tokio::test]
async fn with_no_cluster_list_yet_no_cluster_folder_is_called_removed() {
    let dir = TempDir::new("hk-nocluster");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    let kept = dir.join("cache/some-cluster/health.json");
    put(&kept, 10, H);
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert!(kept.exists(), "an unprimed core (a restart before anybody's page primes it) must not empty the cache");
    let j = job(&r["run"], "fleet-cache");
    assert!(j["notes"].to_string().contains("cluster folders were not checked"), "it says so: {j}");
    // Age still applies: a background file untouched for 8 days is old whatever the clusters are.
    put(&dir.join("cache/some-cluster/nodes.json"), 10, 8 * D);
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(job(&r["run"], "fleet-cache")["items"], json!(1));
    assert!(!dir.join("cache/some-cluster/nodes.json").exists() && kept.exists());
}

#[tokio::test]
async fn the_dry_run_switch_cannot_be_overridden_by_a_run_now() {
    let dir = TempDir::new("hk-dryswitch");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    prime(&c, Some(&admin), &["c1"], "http://127.0.0.1:9").await;
    let gone = dir.join("cache/gone/health.json");
    put(&gone, 10, H);
    c.set_housekeeping_config(Config { dry_run: true, ..Config::default() });
    let g = c.handle(json!({ "type": "HOUSEKEEPING_GET", "session": admin })).await;
    assert_eq!(g["dryRun"], json!(true));
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin, "dryRun": false })).await;
    assert_eq!(r["run"]["dryRun"], json!(true), "HOUSEKEEPING_DRY_RUN holds");
    assert_eq!(job(&r["run"], "fleet-cache")["items"], json!(2), "it still reports what it would remove");
    assert!(gone.exists());
}

/* ------------------------------ sessions and tokens ------------------------------ */

#[tokio::test]
async fn orphaned_zabbix_frame_sessions_expire_and_active_and_ordinary_ones_do_not() {
    let dir = TempDir::new("hk-sessions");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    let alice = add_and_login(&c, &admin, "alice", "user").await;

    // The Zabbix frame signs in on every load and keeps its token in page memory: each
    // reload leaves one behind. Four loads here; the last one is the admin's open frame.
    let mut frames = vec![];
    for _ in 0..4 {
        let code = c.zabbix_sso().issue_code("alice");
        let r = c.handle(json!({ "type": "SSO_EXCHANGE", "code": code })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
        frames.push(r["session"].as_str().unwrap().to_string());
    }
    let code = c.zabbix_sso().issue_code("Admin");
    let mine = c.handle(json!({ "type": "SSO_EXCHANGE", "code": code })).await["session"].as_str().unwrap().to_string();

    // A day on: nobody has used the frames since. A run at that time keeps the ordinary
    // sessions (no SESSION_IDLE_DAYS) and the admin's own, and drops the orphans.
    let later = now_ms() + 25 * 3600 * 1000;
    let report = c.housekeeping_run(RunRequest { trigger: Trigger::Manual, dry_run: true, by: None, protect_session: Some(mine.clone()), now: later }).await.unwrap();
    let j = report.jobs.iter().find(|j| j.id == "sessions").unwrap();
    assert_eq!(j.items, 4, "a dry run counts the four orphans: {j:?}");
    assert!(c.caller_for_session(&frames[0]).is_some(), "and ends nobody");
    let report = c.housekeeping_run(RunRequest { trigger: Trigger::Manual, dry_run: false, by: None, protect_session: Some(mine.clone()), now: later }).await.unwrap();
    assert_eq!(report.jobs.iter().find(|j| j.id == "sessions").unwrap().items, 4);
    for f in &frames {
        assert!(c.caller_for_session(f).is_none(), "an orphaned frame session is gone");
    }
    assert!(c.caller_for_session(&mine).is_some(), "the session of whoever pressed the button is never touched");
    assert!(c.caller_for_session(&alice).is_some() && c.caller_for_session(&admin).is_some(), "ordinary sessions never expire by default");
    let who = c.handle(json!({ "type": "WHOAMI", "session": alice })).await;
    assert_eq!(who["caller"]["name"], json!("alice"), "{who}");

    // With SESSION_IDLE_DAYS set, ordinary sessions idle that long go as well — except the
    // protected one.
    c.set_housekeeping_config(Config { session_idle_days: 30, ..Config::default() });
    let much_later = now_ms() + 31 * DAY;
    let report = c.housekeeping_run(RunRequest { trigger: Trigger::Manual, dry_run: false, by: None, protect_session: Some(admin.clone()), now: much_later }).await.unwrap();
    assert!(report.jobs.iter().find(|j| j.id == "sessions").unwrap().items >= 2);
    assert!(c.caller_for_session(&alice).is_none());
    assert!(c.caller_for_session(&admin).is_some(), "protected");
}

#[tokio::test]
async fn expired_api_tokens_are_deleted_after_thirty_days_and_others_are_kept() {
    let dir = TempDir::new("hk-tokens");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    let mut secrets = std::collections::HashMap::new();
    for (name, days) in [("short", Some(1u64)), ("medium", Some(20)), ("forever", None)] {
        let mut m = json!({ "type": "TOKEN_CREATE", "session": admin, "name": name, "role": "user" });
        if let Some(d) = days {
            m["expiresDays"] = json!(d);
        }
        secrets.insert(name, c.handle(m).await["secret"].as_str().unwrap().to_string());
    }
    let names = |c: &Arc<Core>, admin: &str| {
        let c = c.clone();
        let admin = admin.to_string();
        async move {
            let r = c.handle(json!({ "type": "TOKEN_LIST", "session": admin })).await;
            r["tokens"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        }
    };
    // 40 days on: "short" expired 39 days ago, "medium" 20 days ago.
    let at = now_ms() + 40 * DAY;
    let dry = c.housekeeping_run(RunRequest { trigger: Trigger::Manual, dry_run: true, by: None, protect_session: None, now: at }).await.unwrap();
    assert_eq!(dry.jobs.iter().find(|j| j.id == "api-tokens").unwrap().items, 1);
    assert_eq!(names(&c, &admin).await, vec!["short", "medium", "forever"]);
    c.housekeeping_run(RunRequest { trigger: Trigger::Manual, dry_run: false, by: None, protect_session: None, now: at }).await.unwrap();
    assert_eq!(names(&c, &admin).await, vec!["medium", "forever"]);
    assert!(c.caller_for_token(&secrets["forever"]).is_some(), "a token with no expiry is never touched");
    assert!(c.caller_for_token(&secrets["short"]).is_none());
}

/* --------------------------- the retention jobs and the maps --------------------------- */

#[tokio::test]
async fn rotated_activity_logs_older_than_the_keep_days_go_when_asked() {
    let dir = TempDir::new("hk-actlog");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    put(&dir.join("activity.jsonl.1"), 10, 5 * D);
    put(&dir.join("activity.jsonl.2"), 10, 60 * D);
    put(&dir.join("activity.jsonl.bak"), 10, 600 * D);
    // Off by default: size rotation alone, as it always was.
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert!(job(&r["run"], "activity-log")["skipped"].as_str().unwrap().contains("by size only"));
    assert!(dir.join("activity.jsonl.2").exists());
    c.set_housekeeping_config(Config { activity_keep_days: 30, ..Config::default() });
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(job(&r["run"], "activity-log")["items"], json!(1));
    assert!(!dir.join("activity.jsonl.2").exists());
    assert!(dir.join("activity.jsonl.1").exists() && dir.join("activity.jsonl.bak").exists() && dir.join("activity.jsonl").exists());
}

#[tokio::test]
async fn ended_silences_are_pruned_by_the_daily_job() {
    let dir = TempDir::new("hk-silences");
    let ended = json!([
        { "id": "a", "scope": "cluster", "target": "c1", "reason": "", "by": "x", "at": 1, "until": 2 },
        { "id": "b", "scope": "cluster", "target": "c2", "reason": "", "by": "x", "at": 1, "until": null },
    ]);
    std::fs::write(dir.join("silences.json"), ended.to_string()).unwrap();
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(job(&r["run"], "silences")["items"], json!(1));
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("silences.json")).unwrap()).unwrap();
    assert_eq!(on_disk.as_array().unwrap().len(), 1);
    assert_eq!(on_disk[0]["id"], json!("b"));
}

#[tokio::test]
async fn maps_of_removed_clusters_are_dropped_and_dry_run_leaves_them() {
    let dir = TempDir::new("hk-memory");
    let es = TestServer::start().await;
    let c = core(&dir, Edition::Portable);
    prime(&c, None, &["a", "b"], &es.url()).await;
    for id in ["a", "b"] {
        let r = c.handle(json!({ "type": "ES", "clusterId": id, "method": "GET", "path": "/" })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
    }
    let clusters = |c: &Arc<Core>| c.request_stats()["clusters"].as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(clusters(&c), ["a", "b"].iter().map(|s| s.to_string()).collect());
    // b is removed from the setup.
    prime(&c, None, &["a"], &es.url()).await;

    let dry = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "dryRun": true })).await;
    let mem = job(&dry["run"], "memory");
    assert_eq!(mem["items"], json!(2), "a request counter and a limiter for b (PRIME already dropped the clients): {mem}");
    assert!(mem["notes"].to_string().contains("request counters"), "{mem}");
    assert_eq!(clusters(&c).len(), 2, "a dry run leaves them");

    let real = c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    assert_eq!(job(&real["run"], "memory")["items"], json!(2));
    assert_eq!(clusters(&c), ["a".to_string()].into_iter().collect(), "b's counter is gone, a's stays");
    let again = c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    assert_eq!(job(&again["run"], "memory")["items"], json!(0), "nothing more to drop");
    // The cluster that stayed still works.
    let r = c.handle(json!({ "type": "ES", "clusterId": "a", "method": "GET", "path": "/" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

/* ------------------------------ the timer and the record ------------------------------ */

#[tokio::test]
async fn the_timer_fires_five_minutes_after_start_and_then_every_interval() {
    let dir = TempDir::new("hk-timer");
    let c = core(&dir, Edition::Hosted);
    let t0 = now_ms();
    assert!(c.housekeeping_tick(t0 + 10 * 60_000).await.is_none(), "not armed: nothing runs");
    assert!(c.housekeeping_arm(t0));
    assert_eq!(c.housekeeping_next_run_at(), Some(t0 + FIRST_RUN_DELAY_MS));
    assert!(c.housekeeping_tick(t0 + FIRST_RUN_DELAY_MS - 1).await.is_none(), "four minutes fifty-nine: not yet");
    let first = c.housekeeping_tick(t0 + FIRST_RUN_DELAY_MS).await.expect("due at five minutes");
    assert_eq!(first.trigger, "schedule");
    assert_eq!(first.by, None);
    let next = c.housekeeping_next_run_at().unwrap();
    assert_eq!(next, first.finished_at + 60 * 60_000, "an hour after it finished");
    assert!(c.housekeeping_tick(next - 1).await.is_none());
    // The daily jobs ran the first time and are skipped on the hourly runs that follow.
    assert!(first.jobs.iter().find(|j| j.id == "notifications").unwrap().skipped.is_none());
    let second = c.housekeeping_tick(next).await.expect("due");
    let n = second.jobs.iter().find(|j| j.id == "notifications").unwrap();
    assert_eq!(n.skipped.as_deref(), Some("runs once a day"));
    // A day after the first, they run again.
    let third = c.housekeeping_run(RunRequest::schedule(first.started_at + DAY)).await.unwrap();
    assert!(third.jobs.iter().find(|j| j.id == "notifications").unwrap().skipped.is_none());
    // Run now does not move the schedule.
    let before = c.housekeeping_next_run_at();
    let _ = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "dryRun": true })).await;
    assert_eq!(c.housekeeping_next_run_at(), before);
}

#[tokio::test]
async fn zero_minutes_turns_the_timer_off_but_run_now_still_works() {
    let dir = TempDir::new("hk-off");
    let c = core(&dir, Edition::Hosted);
    c.set_housekeeping_config(Config { minutes: 0, ..Config::default() });
    assert!(!c.housekeeping_arm(0));
    assert!(c.housekeeping_tick(u64::MAX / 2).await.is_none());
    let admin = admin_session(&c).await;
    let g = c.handle(json!({ "type": "HOUSEKEEPING_GET", "session": admin })).await;
    assert_eq!((g["enabled"].clone(), g["nextRunAt"].clone()), (json!(false), Value::Null));
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

#[tokio::test]
async fn each_run_leaves_one_system_event_with_its_counts_in_the_activity_log() {
    let dir = TempDir::new("hk-activity");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    prime(&c, Some(&admin), &["c1"], "http://127.0.0.1:9").await;
    put(&dir.join("cache/gone/health.json"), 10, H);

    let manual = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "session": admin })).await;
    assert_eq!(manual["ok"], json!(true));
    let _ = c.handle(json!({ "type": "HOUSEKEEPING_GET", "session": admin })).await;
    let scheduled = c.housekeeping_run(RunRequest::schedule(now_ms())).await.unwrap();
    c.flush_activity();

    let events: Vec<Value> = std::fs::read_to_string(dir.join("activity.jsonl")).unwrap()
        .lines().map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|e| e["event"]["action"] == json!("housekeeping_run")).collect();
    assert_eq!(events.len(), 2, "one per run, the manual one not recorded twice, the GET not at all: {events:?}");
    let (m, s) = (&events[0], &events[1]);
    assert_eq!(m["user"]["name"], json!("Admin"));
    assert_eq!(m["elasticpro"]["via"], json!("manual"));
    assert_eq!(m["elasticpro"]["detail"]["items"], manual["run"]["items"]);
    assert_eq!(m["elasticpro"]["detail"]["jobs"]["fleet-cache"]["items"], json!(2));
    assert_eq!(m["event"]["outcome"], json!("success"));
    assert_eq!(s["user"]["name"], json!("system"));
    assert_eq!(s["user"]["roles"], json!(["system"]));
    assert_eq!(s["elasticpro"]["via"], json!("schedule"));
    assert_eq!(s["elasticpro"]["detail"]["items"], json!(scheduled.items));
    assert_eq!(s["elasticpro"]["detail"]["dryRun"], json!(false));
}
