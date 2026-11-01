//! The request policy through the message API: modes, the emergency stop, the automatic
//! slow-down, persistence, and who may set it.

mod support;

use elasticpro_core::auth::{authorize, Edition, Role};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{GaugedServer, TempDir, TestServer};

fn portable(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1)
}

async fn prime(c: &Arc<Core>, url: &str, id: &str) {
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": id, "url": url }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

async fn set(c: &Arc<Core>, policy: Value) -> Value {
    let r = c.handle(json!({ "type": "POLICY_SET", "policy": policy })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    r
}

async fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn on_demand_a_fresh_core_sends_nothing_until_a_page_asks_and_then_only_that() {
    let dir = TempDir::new("policy-on-demand");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    let r = set(&c, json!({ "mode": "on-demand", "concurrency": { "perCluster": 1 } })).await;
    assert_eq!(r["policy"]["mode"], json!("on-demand"));
    assert_eq!(r["effective"]["health"], json!("onDemand"), "{r}");
    assert_eq!(r["saved"], json!(true));
    c.start_fleet_poller();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(es.connections(), 0, "the poller went to the cluster on its own: {:?}", es.hits());

    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert_eq!(a["entry"]["status"], json!("ok"), "{a}");
    let paths: Vec<String> = es.hits().into_iter().map(|h| h.path).collect();
    assert!(!paths.is_empty());
    assert!(paths.iter().all(|p| p == "/" || p.starts_with("/_cluster/health")), "only what was asked for: {paths:?}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["mode"], json!("on-demand"), "{st}");
    let cat = st["catalogue"].as_array().unwrap();
    assert!(cat.iter().all(|d| d["effectiveClass"] == json!("onDemand")), "{cat:?}");
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_emergency_stop_holds_everything_tells_the_page_at_once_and_ends_by_itself() {
    let dir = TempDir::new("policy-stop");
    let es = TestServer::start().await;
    // A stop that ends 1.5 s from now, as a core saved it a moment ago.
    let until = now_ms() + 1_500;
    std::fs::write(dir.join("policy.json"), format!(
        r#"{{"mode":"on-demand","paused":{{"all":true,"minutes":15,"since":{},"until":{until},"by":"ann"}}}}"#, now_ms())).unwrap();
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    c.start_fleet_poller();
    // Stopped: the ask is kept, but nobody is held waiting — the page is told at once, by
    // whom, since when and until when.
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert!(t.elapsed() < Duration::from_secs(1), "a stopped ask was held open: {a}");
    assert_eq!((a["ok"].clone(), a["timedOut"].clone()), (json!(true), json!(false)), "{a}");
    assert_eq!(a["paused"]["until"], json!(until), "{a}");
    assert_eq!(a["paused"]["by"], json!("ann"), "{a}");
    assert_eq!(es.connections(), 0, "fetched while stopped");
    // Its end passes: the pending ask runs, and the stop is gone from the file too.
    wait_for("the pending ask to run once the stop ended", || es.connections() > 0).await;
    wait_for("policy.json to lose the stop", || {
        std::fs::read_to_string(dir.join("policy.json")).is_ok_and(|t| !t.contains("\"until\""))
    }).await;
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedAll"], json!(false), "{st}");
}

#[tokio::test]
async fn a_stop_is_stamped_by_the_server_keeps_its_end_and_a_pause_with_no_end_is_dropped() {
    let dir = TempDir::new("policy-stop-stamp");
    let c = portable(&dir);
    let r = set(&c, json!({ "mode": "background" })).await;
    assert!(r["policy"]["paused"].get("since").is_none(), "nothing stopped, nothing stamped: {r}");
    // A new stop: the server stamps since and until.
    let r = c.handle(json!({ "type": "POLICY_PAUSE", "minutes": 30 })).await;
    let since = r["policy"]["paused"]["since"].as_u64().unwrap();
    let until = r["policy"]["paused"]["until"].as_u64().unwrap();
    assert!(since > 5, "{r}");
    assert_eq!(until, since + 30 * 60_000, "{r}");
    assert!(r["policy"]["paused"].get("by").is_none(), "no caller on the portable build: {r}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!((st["policy"]["pausedSince"].clone(), st["policy"]["pausedUntil"].clone()), (json!(since), json!(until)), "{st}");
    assert_eq!(st["policy"]["pausedAll"], json!(true), "{st}");
    // Asked again while it holds: when it began and ends are kept — nobody extends it.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let r = c.handle(json!({ "type": "POLICY_PAUSE", "minutes": 60 })).await;
    assert_eq!((r["policy"]["paused"]["since"].clone(), r["policy"]["paused"]["until"].clone()), (json!(since), json!(until)), "{r}");
    // …and survives a restart.
    drop(c);
    let c = portable(&dir);
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedUntil"], json!(until), "{st}");
    // Lifting it clears the stamp.
    let r = c.handle(json!({ "type": "POLICY_RESUME" })).await;
    assert!(r["policy"]["paused"].get("since").is_none(), "{r}");
    assert_eq!(r["policy"]["paused"]["all"], json!(false), "{r}");
    drop(c);
    // What 0.3.43 left behind — paused for everyone with no end, and one cluster paused —
    // is dropped when the next core reads it.
    std::fs::write(dir.join("policy.json"), r#"{"mode":"hybrid","paused":{"all":true,"clusters":["c1"],"since":5,"by":"Admin"}}"#).unwrap();
    let c = portable(&dir);
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedAll"], json!(false), "{st}");
    assert_eq!(st["policy"]["mode"], json!("hybrid"), "the rest of the file is kept: {st}");
}

#[tokio::test]
async fn policy_set_never_begins_changes_or_lifts_the_stop() {
    let dir = TempDir::new("policy-set-keeps-stop");
    let c = hosted(&dir);
    let (admin, s) = sessions(&c, &[("olga", "operator")]).await;
    let op = &s[0];
    // The admin opens Config › Requests: the policy as it is, no stop.
    let stale = as_session(&c, &admin, json!({ "type": "POLICY_GET" })).await["policy"].clone();
    assert_eq!(stale["paused"], json!({ "all": false }));
    // Meanwhile the operator stops the fleet.
    let r = as_session(&c, op, json!({ "type": "POLICY_PAUSE", "minutes": 30 })).await;
    let stop = r["policy"]["paused"].clone();
    assert_eq!(stop["all"], json!(true), "{r}");
    // The admin saves the form they opened before: the mode changes, the stop does not lift.
    let mut form = stale.clone();
    form["mode"] = json!("hybrid");
    let r = as_session(&c, &admin, json!({ "type": "POLICY_SET", "policy": form })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["policy"]["mode"], json!("hybrid"), "{r}");
    assert_eq!(r["policy"]["paused"], stop, "a stale form lifted the stop: {r}");
    // Nor any other `paused` a payload carries: not lengthened, not ended, not re-stamped.
    for p in [json!({ "all": true, "minutes": 60, "since": 0 }), json!({ "all": false }), json!({ "all": true, "minutes": 15, "since": 1, "until": 2, "by": "x" })] {
        let r = as_session(&c, &admin, json!({ "type": "POLICY_SET", "policy": { "mode": "hybrid", "paused": p } })).await;
        assert_eq!(r["policy"]["paused"], stop, "POLICY_SET changed the stop with {p}: {r}");
    }
    let on_disk: Value = serde_json::from_slice(&std::fs::read(dir.join("policy.json")).unwrap()).unwrap();
    assert_eq!(on_disk["paused"], stop, "and on disk: {on_disk}");
    // With no stop in force, a payload asking for one begins nothing.
    as_session(&c, op, json!({ "type": "POLICY_RESUME" })).await;
    let r = as_session(&c, &admin, json!({ "type": "POLICY_SET", "policy": { "mode": "background", "paused": { "all": true, "minutes": 30 } } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["policy"]["paused"], json!({ "all": false }), "POLICY_SET began a stop: {r}");
    let st = as_session(&c, &admin, json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedAll"], json!(false), "{st}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nobody_waits_more_than_10_s_and_a_slow_cluster_is_slowed_without_anybody_deciding() {
    assert_eq!(elasticpro_core::fleet::MAX_WAIT, Duration::from_secs(10));
    let dir = TempDir::new("policy-slow");
    // Cluster health takes 11 s: past the 10 s a page waits, and past the 8 s that counts as slow.
    let es = GaugedServer::start(|h| (200, r#"{"cluster_name":"slow","status":"green","number_of_nodes":1}"#.to_string(),
        if h.path.starts_with("/_cluster/health") { 11_000 } else { 0 })).await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    set(&c, json!({ "mode": "on-demand" })).await;
    c.start_fleet_poller();
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    let held = t.elapsed();
    assert!(held >= Duration::from_millis(9_500) && held < Duration::from_millis(10_800), "held {held:?}: {a}");
    assert_eq!(a["timedOut"], json!(true), "{a}");
    // The answer arrives a second later; the cluster is marked slowed, said everywhere.
    let deadline = Instant::now() + Duration::from_secs(8);
    let st = loop {
        let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
        if st["automation"]["slowed"]["c1"].is_object() || Instant::now() > deadline { break st; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let s = &st["automation"]["slowed"]["c1"];
    assert!(s["reason"].as_str().unwrap_or("").contains("over 8 s"), "{st}");
    assert_eq!(st["clusters"]["c1"]["slowed"]["level"], json!(1), "{st}");
    let log = c.handle(json!({ "type": "REQUEST_LOG" })).await;
    assert!(log["slowed"]["c1"].is_object(), "the Request Centre is not told: {}", log["slowed"]);
    // Slowed, with a copy held: the page gets it at once rather than waiting again.
    let t = Instant::now();
    let a = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true, "maxAgeSec": 0 })).await;
    assert!(t.elapsed() < Duration::from_secs(1), "a slowed cluster's held copy was not given at once: {a}");
    assert_eq!(a["entry"]["status"], json!("ok"), "{a}");
    assert!(a["slowed"]["since"].as_u64().is_some(), "{a}");
}

#[tokio::test]
async fn the_policy_is_written_0600_and_read_back_by_the_next_core() {
    let dir = TempDir::new("policy-persist");
    {
        let c = portable(&dir);
        let r = set(&c, json!({ "mode": "hybrid", "intervalsSec": { "nodes": 90, "health": 5 }, "watchMinutes": 500 })).await;
        assert_eq!(r["policy"]["intervalsSec"]["nodes"], json!(90));
        assert_eq!(r["policy"]["intervalsSec"]["health"], json!(60), "bounded, not refused");
        assert_eq!(r["policy"]["watchMinutes"], json!(240));
        assert_eq!(r["stored"], json!(true));
    }
    let path = dir.join("policy.json");
    assert!(path.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let c = portable(&dir);
    let g = c.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["ok"], json!(true));
    assert_eq!(g["policy"]["mode"], json!("hybrid"));
    assert_eq!(g["effective"]["health"], json!("background"));
    assert_eq!(g["effective"]["nodes"], json!("onDemand"));
    assert_eq!(g["defaults"]["mode"], json!("on-demand"));
}

#[tokio::test]
async fn a_policy_that_does_not_parse_is_refused_and_nothing_changes() {
    let dir = TempDir::new("policy-bad");
    let c = portable(&dir);
    for bad in [json!({ "mode": "sometimes" }), json!("on-demand"), json!({ "concurrency": "lots" })] {
        let r = c.handle(json!({ "type": "POLICY_SET", "policy": bad })).await;
        assert_eq!(r["ok"], json!(false), "{r}");
        assert_eq!(r["kind"], json!("bad_request"));
    }
    let g = c.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["policy"]["mode"], json!("on-demand"));
    assert_eq!(g["stored"], json!(false));
}

#[tokio::test]
async fn a_fresh_install_runs_client_basis_and_reports_it_as_the_defaults() {
    let dir = TempDir::new("policy-client-basis");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    let g = c.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["policy"]["mode"], json!("on-demand"), "{g}");
    assert_eq!(g["resolvedMode"], json!("on-demand"), "{g}");
    assert_eq!(g["stored"], json!(false));
    assert_eq!(g["policy"]["concurrency"]["perCluster"], json!(1));
    assert_eq!(g["policy"]["concurrency"]["global"], json!(4));
    assert_eq!(g["policy"], g["defaults"], "no file: the policy running is the shipped one");
    // Reported either way, so the page can tell "not set" from an older core that does not say.
    assert!(g.get("pollConcurrencyEnv").is_some(), "{g}");
    if std::env::var("ELASTICPRO_POLL_CONCURRENCY").is_err() {
        assert_eq!(g["pollConcurrencyEnv"], Value::Null, "{g}");
    }
    assert!(g["effective"].as_object().unwrap().values().all(|v| v == "onDemand"), "{g}");
    let st = c.handle(json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["mode"], json!("on-demand"), "{st}");
    assert_eq!(st["policy"]["resolvedMode"], json!("on-demand"), "{st}");
}

#[tokio::test]
async fn a_policy_somebody_saved_is_not_rewritten_and_auto_still_resolves_by_fleet_size() {
    let dir = TempDir::new("policy-saved-auto");
    let es = TestServer::start().await;
    let c = portable(&dir);
    prime(&c, &es.url(), "c1").await;
    let r = set(&c, json!({ "mode": "auto" })).await;
    assert_eq!(r["policy"]["mode"], json!("auto"), "{r}");
    assert_eq!(r["resolvedMode"], json!("background"), "{r}");
    assert_eq!(r["effective"]["nodes"], json!("background"));
    // A file that leaves concurrency out keeps the classic numbers it always had.
    assert_eq!(r["policy"]["concurrency"]["perCluster"], json!(2), "{r}");
    let before = std::fs::read(dir.join("policy.json")).unwrap();
    drop(c);
    let c2 = portable(&dir);
    let g = c2.handle(json!({ "type": "POLICY_GET" })).await;
    assert_eq!(g["policy"]["mode"], json!("auto"), "{g}");
    assert_eq!(g["defaults"]["mode"], json!("on-demand"));
    assert_eq!(std::fs::read(dir.join("policy.json")).unwrap(), before, "reading never rewrites the file");
}

#[test]
fn reading_the_policy_takes_a_user_and_changing_it_an_administrator() {
    assert!(authorize(Role::User, "POLICY_GET", "", "").is_ok());
    assert!(authorize(Role::Guest, "POLICY_GET", "", "").is_err());
    assert!(authorize(Role::Operator, "POLICY_SET", "", "").is_err());
    assert!(authorize(Role::Admin, "POLICY_SET", "", "").is_ok());
    // The emergency stop alone is an operator's (POLICY_PAUSE / POLICY_RESUME).
    for t in ["POLICY_PAUSE", "POLICY_RESUME"] {
        assert!(authorize(Role::Operator, t, "", "").is_ok(), "{t}");
        assert!(authorize(Role::User, t, "", "").is_err(), "{t}");
    }
}

/* ------------------- the emergency stop, an operator's (POLICY_PAUSE) ------------------- */

const PASSWORD: &str = "correct-horse-battery";

fn hosted(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

/// Signed in as the shipped admin with its password replaced, and the named accounts added.
async fn sessions(c: &Arc<Core>, accounts: &[(&str, &str)]) -> (String, Vec<String>) {
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let admin = r["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": admin, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    let mut out = vec![];
    for (name, role) in accounts {
        let a = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role })).await;
        assert_eq!(a["ok"], json!(true), "{a}");
        let l = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
        out.push(l["session"].as_str().expect("a session").to_string());
    }
    (admin, out)
}

async fn as_session(c: &Arc<Core>, s: &str, mut msg: Value) -> Value {
    msg["session"] = json!(s);
    c.handle(msg).await
}

/// The policy with the stop taken out: what an operator must never change.
fn rest(p: &Value) -> Value {
    let mut p = p.clone();
    p.as_object_mut().unwrap().remove("paused");
    p
}

#[tokio::test]
async fn an_operator_begins_and_ends_the_emergency_stop_and_changes_nothing_else() {
    let dir = TempDir::new("policy-operator-stop");
    let c = hosted(&dir);
    let (admin, s) = sessions(&c, &[("olga", "operator"), ("ursula", "user")]).await;
    let (op, user) = (&s[0], &s[1]);
    // The admin's policy, not the shipped one, so "nothing else changed" means something.
    let r = as_session(&c, &admin, json!({ "type": "POLICY_SET", "policy": { "mode": "hybrid", "budgetPerClusterPerMin": 12 } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let before = rest(&r["policy"]);

    let t0 = now_ms();
    let r = as_session(&c, op, json!({ "type": "POLICY_PAUSE", "minutes": 30 })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["saved"], json!(true), "{r}");
    let p = &r["policy"]["paused"];
    assert_eq!((p["all"].clone(), p["minutes"].clone(), p["by"].clone()), (json!(true), json!(30), json!("olga")), "{r}");
    let until = p["until"].as_u64().unwrap();
    assert!(until >= t0 + 30 * 60_000 && until <= now_ms() + 30 * 60_000, "{r}");
    assert_eq!(rest(&r["policy"]), before, "the stop and nothing else");
    let on_disk: Value = serde_json::from_slice(&std::fs::read(dir.join("policy.json")).unwrap()).unwrap();
    assert_eq!(on_disk["paused"]["by"], json!("olga"), "kept like any other stop: {on_disk}");
    let st = as_session(&c, user, json!({ "type": "FLEET_STATE" })).await;
    assert_eq!(st["policy"]["pausedAll"], json!(true), "every page says so: {st}");
    assert_eq!(st["policy"]["pausedBy"], json!("olga"), "{st}");

    // Asked again while it holds: kept as it is, not lengthened.
    let r = as_session(&c, op, json!({ "type": "POLICY_PAUSE", "minutes": 60 })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["policy"]["paused"]["until"], json!(until), "{r}");
    assert_eq!(r["policy"]["paused"]["minutes"], json!(30), "{r}");

    // A user may read the stop, never begin or end it.
    for m in [json!({ "type": "POLICY_PAUSE", "minutes": 15 }), json!({ "type": "POLICY_RESUME" })] {
        let r = as_session(&c, user, m.clone()).await;
        assert_eq!(r["kind"], json!("forbidden"), "{m} -> {r}");
    }

    let r = as_session(&c, op, json!({ "type": "POLICY_RESUME" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["policy"]["paused"], json!({ "all": false }), "{r}");
    assert_eq!(rest(&r["policy"]), before, "ending it changes nothing else either");
    // Ending a stop that is not in force is harmless.
    let r = as_session(&c, op, json!({ "type": "POLICY_RESUME" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    // An admin's stop is an operator's to end.
    let r = as_session(&c, &admin, json!({ "type": "POLICY_PAUSE", "minutes": 15 })).await;
    assert_eq!(r["policy"]["paused"]["by"], json!("Admin"), "{r}");
    let r = as_session(&c, op, json!({ "type": "POLICY_RESUME" })).await;
    assert_eq!(r["policy"]["paused"]["all"], json!(false), "{r}");
}

#[tokio::test]
async fn an_operator_sets_no_other_policy_field() {
    let dir = TempDir::new("policy-operator-fields");
    let c = hosted(&dir);
    let (admin, s) = sessions(&c, &[("olga", "operator")]).await;
    let op = &s[0];
    let before = as_session(&c, &admin, json!({ "type": "POLICY_GET" })).await;
    // The whole policy: an administrator's.
    let r = as_session(&c, op, json!({ "type": "POLICY_SET", "policy": { "mode": "background", "paused": { "all": true, "minutes": 15 } } })).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");
    // A stop that carries a policy along is refused whole, not half-applied.
    let r = as_session(&c, op, json!({ "type": "POLICY_PAUSE", "minutes": 15, "policy": { "mode": "background" } })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    let r = as_session(&c, op, json!({ "type": "POLICY_RESUME", "policy": { "budgetPerClusterPerMin": 0 } })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    // Only the lengths the page offers; none named is refused, not the shortest by default.
    for m in [json!(45), json!(0), json!("30"), Value::Null] {
        let r = as_session(&c, op, json!({ "type": "POLICY_PAUSE", "minutes": m })).await;
        assert_eq!(r["kind"], json!("bad_request"), "{m} -> {r}");
    }
    let after = as_session(&c, &admin, json!({ "type": "POLICY_GET" })).await;
    assert_eq!(after["policy"], before["policy"], "nothing changed");
    assert_eq!(after["stored"], json!(false), "nothing written");
}

#[tokio::test]
async fn a_limited_operator_and_a_display_link_cannot_stop_the_fleet() {
    use elasticpro_core::auth::{Caller, PlayCaller};
    let dir = TempDir::new("policy-limited-stop");
    let c = hosted(&dir);
    let _ = sessions(&c, &[]).await;
    let who = |name: &str, role, scope: Option<Vec<String>>| Caller { name: name.into(), role, must_change: false, scope, play: None };
    let team = || Some(vec!["ES team A".to_string()]);
    // An operator limited to some Zabbix host groups: the stop would hold the others too.
    for m in [json!({ "type": "POLICY_PAUSE", "minutes": 15 }), json!({ "type": "POLICY_RESUME" })] {
        let r = c.handle_as(m.clone(), Some(who("uma@zabbix", Role::Operator, team()))).await;
        assert_eq!(r["kind"], json!("forbidden"), "{m} -> {r}");
        assert!(r["message"].as_str().unwrap().contains("limited to some clusters"), "{r}");
    }
    // A display link, whatever role its session carries: the gate refuses it.
    let mut tv = who("display:Lobby", Role::User, None);
    tv.play = Some(PlayCaller { link: "l1".into(), clusters: None, allow_from: vec![] });
    for role in [Role::User, Role::Operator] {
        tv.role = role;
        let r = c.handle_as(json!({ "type": "POLICY_PAUSE", "minutes": 15 }), Some(tv.clone())).await;
        assert_eq!(r["kind"], json!("forbidden"), "{r}");
        assert_eq!(r["playOnly"], json!(true), "{r}");
    }
    let g = c.handle_as(json!({ "type": "POLICY_GET" }), Some(who("ann", Role::Admin, None))).await;
    assert_eq!(g["policy"]["paused"]["all"], json!(false), "nothing was stopped: {g}");
    // An administrator may, limited or not (POLICY_SET is theirs anyway); so may an operator who sees every cluster.
    let r = c.handle_as(json!({ "type": "POLICY_PAUSE", "minutes": 15 }), Some(who("zadmin@zabbix", Role::Admin, team()))).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = c.handle_as(json!({ "type": "POLICY_RESUME" }), Some(who("olga@zabbix", Role::Operator, None))).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["policy"]["paused"]["all"], json!(false), "{r}");
}
