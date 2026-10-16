//! The activity log, through the real message API: what a person did must be findable by an
//! administrator afterwards, and nobody else may read it.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";

async fn signed_in(c: &std::sync::Arc<Core>, name: &str, password: &str) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": password })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    res["session"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn reads_and_refused_writes_are_listed_for_an_admin_only() {
    let dir = TempDir::new("activity");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let first = signed_in(&c, "Admin", elasticpro_core::auth::DEFAULT_PASSWORD).await;
    c.handle(json!({ "type": "USER_SET_PASSWORD", "session": first, "name": "Admin", "password": PASSWORD })).await;
    let admin = signed_in(&c, "Admin", PASSWORD).await;
    let add = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": "reader", "password": PASSWORD, "role": "user" })).await;
    assert_eq!(add["ok"], json!(true), "{add}");
    let reader = signed_in(&c, "reader", PASSWORD).await;

    c.handle(json!({ "type": "ES", "session": reader, "clusterId": "x", "method": "GET", "path": "/_cat/indices?v=true" })).await;
    let refused = c.handle(json!({ "type": "ES", "session": reader, "clusterId": "x", "method": "PUT", "path": "/orders", "body": "{\"secret\":1}" })).await;
    assert_eq!(refused["ok"], json!(false), "{refused}");
    // A wrong password is a failure under the name that was typed.
    c.handle(json!({ "type": "LOGIN", "name": "reader", "password": "not-the-password" })).await;

    // Not an admin: refused, and asking is not itself an event.
    let denied = c.handle(json!({ "type": "ACTIVITY_LIST", "session": reader })).await;
    assert_eq!(denied["ok"], json!(false));
    assert_eq!(denied["kind"], json!("forbidden"), "{denied}");

    let res = c.handle(json!({ "type": "ACTIVITY_LIST", "session": admin, "user": "reader" })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let events = res["events"].as_array().unwrap();
    let find = |m: &str| events.iter().find(|e| e["event"]["action"] == "es" && e["http"]["request"]["method"] == m).cloned();

    let read = find("GET").expect("the read is recorded");
    assert_eq!(read["user"]["name"], "reader");
    assert_eq!(read["url"]["path"], "/_cat/indices");
    assert_eq!(read["url"]["query"], "v=true");
    assert_eq!(read["elasticpro"]["via"], "session");
    let write = find("PUT").expect("the refused write is recorded");
    assert_eq!(write["event"]["outcome"], "failure");
    assert!(write["error"]["code"].is_string(), "{write}");
    assert!(events.iter().any(|e| e["event"]["action"] == "login" && e["event"]["outcome"] == "failure" && e["user"]["name"] == "reader"));
    assert!(events.iter().all(|e| e["event"]["action"] != "activity_list"));
    assert!(res["file"].is_string());

    let only_failed = c.handle(json!({ "type": "ACTIVITY_LIST", "session": admin, "failedOnly": true })).await;
    assert!(only_failed["events"].as_array().unwrap().iter().all(|e| e["event"]["outcome"] == "failure"));

    // The file has the same lines, and none of what must not be there.
    let text = std::fs::read_to_string(dir.0.join("activity.jsonl")).expect("the log file");
    assert!(text.lines().count() >= 4);
    for l in text.lines() { serde_json::from_str::<Value>(l).expect("JSON per line"); }
    assert!(!text.contains(PASSWORD) && !text.contains("not-the-password") && !text.contains(&reader) && !text.contains("secret"));
}
