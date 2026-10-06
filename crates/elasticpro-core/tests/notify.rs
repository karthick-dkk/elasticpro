//! The notification history, through the message API the bell uses.
//!
//! What matters: a task is one record from start to finish, nobody sees or clears anybody
//! else's, nothing older than the retention comes back, and a caller the rest of the
//! bridge would refuse is refused here too.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";
const DAY: u64 = 86_400_000;

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

fn core(dir: &TempDir, edition: Edition) -> std::sync::Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), edition, 1)
}

async fn admin_session(c: &std::sync::Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(c) })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c
        .handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": PASSWORD }))
        .await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn user(c: &std::sync::Arc<Core>, admin: &str, name: &str, role: &str) -> String {
    let add = c
        .handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role }))
        .await;
    assert_eq!(add["ok"], json!(true), "{add}");
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    res["session"].as_str().unwrap().to_string()
}

fn with_session(mut msg: Value, s: Option<&str>) -> Value {
    if let Some(s) = s {
        msg["session"] = json!(s);
    }
    msg
}

async fn put(c: &std::sync::Arc<Core>, s: Option<&str>, body: Value) -> Value {
    let mut m = body;
    m["type"] = json!("NOTIFY_PUT");
    c.handle(with_session(m, s)).await
}

async fn list(c: &std::sync::Arc<Core>, s: Option<&str>, opts: Value) -> Value {
    let mut m = opts;
    m["type"] = json!("NOTIFY_LIST");
    let res = c.handle(with_session(m, s)).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    res
}

fn messages(res: &Value) -> Vec<String> {
    res["items"].as_array().unwrap().iter().map(|r| r["message"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn ping_says_the_store_is_there() {
    let dir = TempDir::new("notify-ping");
    let ping = core(&dir, Edition::Portable).handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["notifyStore"], json!(true));
    assert_eq!(ping["notifyDays"], json!(30));
}

#[tokio::test]
async fn a_task_is_one_record_from_start_to_finish() {
    let dir = TempDir::new("notify-upsert");
    let c = core(&dir, Edition::Portable);

    let r = put(&c, None, json!({ "id": "task-1-1", "message": "Restore started", "kind": "run",
        "detail": ["logs-2026.09.01"], "meta": "prod · started just now", "at": now() - 5000 })).await;
    assert_eq!(r, json!({ "ok": true, "id": "task-1-1" }));
    let r = put(&c, None, json!({ "id": "task-1-1", "message": "Restore finished", "kind": "ok",
        "detail": ["logs-2026.09.01", "3 shards"], "meta": "prod · took 40 s", "at": now() })).await;
    assert_eq!(r["ok"], json!(true));

    let res = list(&c, None, json!({})).await;
    let items = res["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "run then ok under one id must stay one record: {res}");
    assert_eq!(items[0]["kind"], json!("ok"));
    assert_eq!(items[0]["message"], json!("Restore finished"));
    assert_eq!(items[0]["detail"], json!(["logs-2026.09.01", "3 shards"]));
    assert!(items[0].get("user").is_none(), "the owner is implicit, never echoed");
    assert!(items[0]["updatedAt"].as_u64().is_some());

    // No id: a new record every time, with an id to refer to it by.
    let a = put(&c, None, json!({ "message": "one", "kind": "ok" })).await;
    let b = put(&c, None, json!({ "message": "two", "kind": "warn" })).await;
    assert_ne!(a["id"], b["id"]);
    assert_eq!(list(&c, None, json!({})).await["items"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn newest_first_with_paging() {
    let dir = TempDir::new("notify-page");
    let c = core(&dir, Edition::Portable);
    let t = now() - 60_000;
    for i in 0..5u64 {
        put(&c, None, json!({ "id": format!("n{i}"), "message": format!("m{i}"), "kind": "ok", "at": t + i * 1000 })).await;
    }
    let first = list(&c, None, json!({ "limit": 2 })).await;
    assert_eq!(messages(&first), ["m4", "m3"]);
    assert_eq!(first["more"], json!(true));
    let before = first["items"][1]["at"].as_u64().unwrap();
    let next = list(&c, None, json!({ "limit": 10, "before": before })).await;
    assert_eq!(messages(&next), ["m2", "m1", "m0"]);
    assert_eq!(next["more"], json!(false));

    // `since` is about what changed, not when it happened.
    let mark = now();
    std::thread::sleep(std::time::Duration::from_millis(5));
    put(&c, None, json!({ "id": "n0", "message": "m0 again", "kind": "err", "at": t })).await;
    assert_eq!(messages(&list(&c, None, json!({ "since": mark })).await), ["m0 again"]);
}

#[tokio::test]
async fn nobody_sees_or_clears_anybody_elses() {
    let dir = TempDir::new("notify-users");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    let bob = user(&c, &admin, "bob", "user").await;
    let gus = user(&c, &admin, "gus", "guest").await;

    put(&c, Some(&admin), json!({ "id": "same", "message": "admin's", "kind": "ok" })).await;
    put(&c, Some(&bob), json!({ "id": "same", "message": "bob's", "kind": "err" })).await;
    // A guest may keep a history too — it is not a cluster write.
    assert_eq!(put(&c, Some(&gus), json!({ "message": "gus's", "kind": "warn" })).await["ok"], json!(true));

    // A `user` in the message is ignored: the caller is who the session says.
    put(&c, Some(&bob), json!({ "id": "sneak", "user": "elasticpro", "message": "bob again", "kind": "ok" })).await;

    assert_eq!(messages(&list(&c, Some(&admin), json!({})).await), ["admin's"]);
    let mut b = messages(&list(&c, Some(&bob), json!({})).await);
    b.sort();
    assert_eq!(b, ["bob again", "bob's"]);
    assert_eq!(messages(&list(&c, Some(&gus), json!({})).await), ["gus's"]);

    let cleared = c.handle(json!({ "type": "NOTIFY_CLEAR", "session": &bob })).await;
    assert_eq!(cleared, json!({ "ok": true, "removed": 2 }));
    assert!(messages(&list(&c, Some(&bob), json!({})).await).is_empty());
    assert_eq!(messages(&list(&c, Some(&admin), json!({})).await), ["admin's"], "bob's clear took admin's");
    assert_eq!(messages(&list(&c, Some(&gus), json!({})).await), ["gus's"]);
}

#[tokio::test]
async fn nothing_older_than_thirty_days_comes_back() {
    let dir = TempDir::new("notify-prune");
    let c = core(&dir, Edition::Portable);
    put(&c, None, json!({ "id": "old", "message": "old", "kind": "ok", "at": now() - 31 * DAY })).await;
    put(&c, None, json!({ "id": "edge", "message": "29 days", "kind": "ok", "at": now() - 29 * DAY })).await;
    put(&c, None, json!({ "id": "new", "message": "new", "kind": "ok" })).await;
    assert_eq!(messages(&list(&c, None, json!({})).await), ["new", "29 days"]);
}

#[tokio::test]
async fn pruned_on_load_and_kept_across_a_restart() {
    let dir = TempDir::new("notify-load");
    let t = now();
    let rec = |id: &str, user: &str, at: u64| json!({ "id": id, "user": user, "message": id, "kind": "ok",
        "detail": [], "meta": "", "at": at, "updatedAt": at });
    std::fs::write(
        dir.join("notifications.json"),
        serde_json::to_vec(&json!({ "version": 1, "records": [
            rec("stale", "local", t - 40 * DAY), rec("fresh", "local", t - DAY), rec("other", "someone", t - DAY),
        ]}))
        .unwrap(),
    )
    .unwrap();

    let c = core(&dir, Edition::Portable);
    assert_eq!(messages(&list(&c, None, json!({})).await), ["fresh"]);
    put(&c, None, json!({ "id": "added", "message": "added", "kind": "run" })).await;
    c.flush_notifications();
    drop(c);

    let on_disk: Value = serde_json::from_slice(&std::fs::read(dir.join("notifications.json")).unwrap()).unwrap();
    let ids: Vec<&str> = on_disk["records"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert!(!ids.contains(&"stale"), "a pruned record was written back: {ids:?}");
    assert!(ids.contains(&"other"), "somebody else's history must survive: {ids:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("notifications.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let again = core(&dir, Edition::Portable);
    assert_eq!(messages(&list(&again, None, json!({})).await), ["added", "fresh"]);
}

#[tokio::test]
async fn bad_input_is_refused_and_stores_nothing() {
    let dir = TempDir::new("notify-bad");
    let c = core(&dir, Edition::Portable);
    let long = "x".repeat(2001);
    let many: Vec<String> = (0..41).map(|i| i.to_string()).collect();
    for bad in [
        json!({ "kind": "ok" }),
        json!({ "message": "   ", "kind": "ok" }),
        json!({ "message": long, "kind": "ok" }),
        json!({ "message": "m", "kind": "info" }),
        json!({ "message": "m" }),
        json!({ "message": "m", "kind": "ok", "id": "has space" }),
        json!({ "message": "m", "kind": "ok", "id": "" }),
        json!({ "message": "m", "kind": "ok", "id": "x".repeat(129) }),
        json!({ "message": "m", "kind": "ok", "id": 7 }),
        json!({ "message": "m", "kind": "ok", "detail": "not a list" }),
        json!({ "message": "m", "kind": "ok", "detail": [1, 2] }),
        json!({ "message": "m", "kind": "ok", "detail": many }),
        json!({ "message": "m", "kind": "ok", "meta": 5 }),
        json!({ "message": "m", "kind": "ok", "at": "yesterday" }),
        json!({ "message": "m", "kind": "ok", "at": -1 }),
    ] {
        let res = put(&c, None, bad.clone()).await;
        assert_eq!(res["ok"], json!(false), "accepted {bad}: {res}");
        assert_eq!(res["kind"], json!("bad_message"), "{bad}: {res}");
    }
    assert!(messages(&list(&c, None, json!({})).await).is_empty());

    // A time in the future is clamped to now rather than sorting above everything forever.
    put(&c, None, json!({ "id": "f", "message": "future", "kind": "ok", "at": now() + 365 * DAY })).await;
    let at = list(&c, None, json!({})).await["items"][0]["at"].as_u64().unwrap();
    assert!(at <= now());
}

#[tokio::test]
async fn without_a_session_it_is_refused_like_everything_else() {
    let dir = TempDir::new("notify-unauth");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    put(&c, Some(&admin), json!({ "message": "mine", "kind": "ok" })).await;

    for t in ["NOTIFY_PUT", "NOTIFY_LIST", "NOTIFY_CLEAR"] {
        let res = c.handle(json!({ "type": t, "message": "m", "kind": "ok" })).await;
        assert_eq!(res["kind"], json!("unauthenticated"), "{t} without a session: {res}");
        let res = c.handle(json!({ "type": t, "session": "not-a-session", "message": "m", "kind": "ok" })).await;
        assert_eq!(res["kind"], json!("unauthenticated"), "{t} with a dead session: {res}");
    }
    assert_eq!(messages(&list(&c, Some(&admin), json!({})).await), ["mine"]);
}

#[tokio::test]
async fn the_shipped_password_gets_no_history() {
    let dir = TempDir::new("notify-mustchange");
    let c = core(&dir, Edition::Installed);
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(&c) })).await;
    let s = res["session"].as_str().unwrap();
    let r = c.handle(json!({ "type": "NOTIFY_LIST", "session": s })).await;
    assert_eq!(r["kind"], json!("must_change_password"), "{r}");
}

#[tokio::test]
async fn portable_has_one_person_and_needs_no_session() {
    // Portable has no accounts: everything belongs to "local".
    let dir = TempDir::new("notify-portable");
    let c = core(&dir, Edition::Portable);
    assert_eq!(c.handle(json!({ "type": "NOTIFY_CLEAR" })).await, json!({ "ok": true, "removed": 0 }));
}
