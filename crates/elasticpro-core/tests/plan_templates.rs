//! Plan templates (docs/REPORTS.md "Planning"): who may read and replace them, what is kept,
//! what is refused, and the audit line. Its own binary: the audit capture is a thread-local
//! subscriber (see play_audit.rs for why that wants a process to itself).

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::fleet::events::Reauth;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";

fn hosted(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

async fn login(c: &Arc<Core>, name: &str, pw: &str) -> String {
    let r = c.handle(json!({ "type": "LOGIN", "name": name, "password": pw })).await;
    r["session"].as_str().expect("a session").to_string()
}

async fn admin_session(c: &Arc<Core>) -> String {
    let s = login(c, "Admin", elasticpro_core::auth::DEFAULT_PASSWORD).await;
    c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    s
}

async fn call(c: &Arc<Core>, s: &str, mut m: Value) -> Value {
    m["session"] = json!(s);
    c.handle(m).await
}

#[derive(Clone, Default)]
struct Lines(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Lines {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn seeds_then_save_validate_audit_and_survive_a_restart() {
    let dir = TempDir::new("plan-templates");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let lines = Lines::default();
    let sub = tracing_subscriber::fmt().json().with_writer({ let l = lines.clone(); move || l.clone() })
        .with_max_level(tracing::Level::INFO).finish();
    let _guard = tracing::subscriber::set_default(sub);

    // No file: the two seeded templates.
    let g = call(&c, &s, json!({ "type": "PLAN_TEMPLATES_GET" })).await;
    assert_eq!(g["ok"], json!(true), "{g}");
    assert_eq!(g["custom"], json!(false));
    let names: Vec<&str> = g["templates"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Standard", "Small / lab"]);
    let std_roles = g["templates"][0]["roles"].as_array().unwrap();
    assert_eq!(std_roles.len(), 11);
    assert_eq!(std_roles[2]["nodeTB"], json!(8), "hot node size is the editable stand-in");
    assert_eq!(std_roles[3]["nodeTB"], Value::Null, "the owner has not given warm: [set]");
    assert!(!dir.join("plan-templates.json").exists(), "reading writes nothing");

    // Refused, and kept as it was.
    let dup = call(&c, &s, json!({ "type": "PLAN_TEMPLATES_SET", "templates": [{ "name": "A", "roles": [] }, { "name": "a", "roles": [] }] })).await;
    assert_eq!(dup["kind"], json!("bad_request"), "{dup}");
    for bad in [
        json!([{ "name": "A", "roles": [{ "name": "x", "rule": "nope" }] }]),
        json!([{ "name": "A", "roles": [{ "name": "x", "rule": "volume", "cap": -5 }] }]),
        json!([{ "name": "A", "backup": "tape", "roles": [] }]),
        json!([]),
    ] {
        assert_eq!(call(&c, &s, json!({ "type": "PLAN_TEMPLATES_SET", "templates": bad })).await["kind"], json!("bad_request"));
    }
    assert_eq!(call(&c, &s, json!({ "type": "PLAN_TEMPLATES_GET" })).await["custom"], json!(false));

    // Saved: answers as GET, in the file, audited, in the activity log.
    let list = json!([{ "name": "Mine", "backup": "ulm", "roles": [
        { "on": true, "name": "Forwarder", "rule": "volume", "cap": 200, "cpu": 4, "ram": null, "root": 100, "notes": "n" },
        { "on": false, "name": "Archive", "rule": "target", "target": "ulm", "cap": null } ] }]);
    let set = call(&c, &s, json!({ "type": "PLAN_TEMPLATES_SET", "templates": list })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["custom"], json!(true));
    assert_eq!(set["updatedBy"], json!("Admin"));
    assert_eq!(set["templates"][0]["roles"][0]["ram"], Value::Null, "an empty value stays empty, never 0");
    assert!(std::fs::read_to_string(dir.join("plan-templates.json")).unwrap().contains("Mine"));
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(text.lines().any(|l| l.contains("\"target\":\"audit\"") && l.contains("plan templates changed") && l.contains("Mine") && l.contains("\"user\":\"Admin\"")), "{text}");

    let act = call(&c, &s, json!({ "type": "ACTIVITY_LIST", "user": "Admin" })).await;
    let events = act["events"].as_array().unwrap();
    let ev = events.iter().find(|e| e["event"]["action"] == "plan_templates_set" && e["event"]["outcome"] == "success")
        .unwrap_or_else(|| panic!("the save is in the activity log: {act}"));
    assert_eq!(ev["event"]["category"], json!(["configuration"]), "{ev}");
    assert!(events.iter().all(|e| e["event"]["action"] != "plan_templates_get"), "opening the page is a poll, not an event");

    drop(c);
    let c = hosted(&dir);
    let s = login(&c, "Admin", PASSWORD).await;
    let g = call(&c, &s, json!({ "type": "PLAN_TEMPLATES_GET" })).await;
    assert_eq!(g["templates"][0]["name"], json!("Mine"), "{g}");
}

#[tokio::test]
async fn who_may_read_and_who_may_replace() {
    let dir = TempDir::new("plan-templates-auth");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    for (n, r) in [("ula", "user"), ("olga", "operator")] {
        let add = call(&c, &s, json!({ "type": "USER_ADD", "name": n, "password": PASSWORD, "role": r })).await;
        assert_eq!(add["ok"], json!(true), "{add}");
    }
    let one = json!([{ "name": "X", "roles": [] }]);
    for n in ["ula", "olga"] {
        let t = login(&c, n, PASSWORD).await;
        assert_eq!(call(&c, &t, json!({ "type": "PLAN_TEMPLATES_GET" })).await["ok"], json!(true), "{n} reads");
        let r = call(&c, &t, json!({ "type": "PLAN_TEMPLATES_SET", "templates": one })).await;
        assert_eq!((r["ok"].clone(), r["kind"].clone()), (json!(false), json!("forbidden")), "{n} cannot set: {r}");
    }
    // An anonymous call (no session) never reaches either.
    assert_eq!(c.handle(json!({ "type": "PLAN_TEMPLATES_GET" })).await["ok"], json!(false));

    // An administrator limited to some clusters is refused, like Play's fleet-wide settings.
    let limited = Caller { name: "zadmin@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["ES one".into()]), play: None };
    let r = c.handle_as(json!({ "type": "PLAN_TEMPLATES_SET", "templates": one }), Some(limited.clone())).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");
    assert_eq!(c.handle_as(json!({ "type": "PLAN_TEMPLATES_GET" }), Some(limited)).await["ok"], json!(true), "reading is fine");
    let full = Caller { name: "root".into(), role: Role::Admin, must_change: false, scope: None, play: None };
    assert_eq!(c.handle_as(json!({ "type": "PLAN_TEMPLATES_SET", "templates": one }), Some(full)).await["ok"], json!(true));
}

#[tokio::test]
async fn a_display_link_reaches_neither_message() {
    let dir = TempDir::new("plan-templates-link");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let made = call(&c, &s, json!({ "type": "PLAY_LINK_CREATE", "name": "wall" })).await;
    let secret = made["secret"].as_str().expect("a link secret").to_string();
    let ip: Option<IpAddr> = Some("10.0.0.1".parse().unwrap());
    let ex = c.handle_as_from_at(json!({ "type": "PLAY_EXCHANGE", "secret": secret }), None, Reauth::None, ip).await;
    let tok = ex["session"].as_str().unwrap().to_string();
    for t in ["PLAN_TEMPLATES_GET", "PLAN_TEMPLATES_SET"] {
        let caller = c.caller_for_session(&tok);
        let r = c.handle_as_from_at(json!({ "type": t, "session": tok, "templates": [{ "name": "X", "roles": [] }] }), caller, Reauth::Session(tok.clone()), ip).await;
        assert_eq!(r["ok"], json!(false), "{t}: {r}");
        assert!(r["message"].as_str().unwrap_or("").contains("display link"), "{t}: {r}");
    }
}

#[tokio::test]
async fn the_desktop_build_answers_from_memory() {
    let dir = TempDir::new("plan-templates-portable");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let g = c.handle(json!({ "type": "PLAN_TEMPLATES_GET" })).await;
    assert_eq!(g["templates"].as_array().unwrap().len(), 2, "{g}");
    let set = c.handle(json!({ "type": "PLAN_TEMPLATES_SET", "templates": [{ "name": "X", "roles": [] }] })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert!(!dir.join("plan-templates.json").exists(), "no file off the hosted build: the page keeps them in the browser");
}
