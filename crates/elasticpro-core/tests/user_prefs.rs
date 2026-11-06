//! "Your settings" through the message API (user_prefs.rs): kept with the account, the
//! caller's own and nobody else's, `null` where nothing was set, a refused patch saves
//! nothing, and the file comes back after a restart.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";

fn core(dir: &TempDir) -> std::sync::Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1)
}

async fn login(c: &std::sync::Arc<Core>, name: &str, password: &str) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": password })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    res["session"].as_str().unwrap().to_string()
}

async fn admin_session(c: &std::sync::Arc<Core>) -> String {
    let s = login(c, "Admin", elasticpro_core::auth::DEFAULT_PASSWORD).await;
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn user(c: &std::sync::Arc<Core>, admin: &str, name: &str, role: &str) -> String {
    let add = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role })).await;
    assert_eq!(add["ok"], json!(true), "{add}");
    login(c, name, PASSWORD).await
}

async fn get(c: &std::sync::Arc<Core>, s: &str) -> Value {
    let r = c.handle(json!({ "type": "PREFS_GET", "session": s })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    r
}

async fn set(c: &std::sync::Arc<Core>, s: &str, prefs: Value) -> Value {
    c.handle(json!({ "type": "PREFS_SET", "session": s, "prefs": prefs })).await
}

#[tokio::test]
async fn settings_follow_the_account_and_reach_nobody_else() {
    let dir = TempDir::new("prefs-own");
    let c = core(&dir);
    let admin = admin_session(&c).await;
    let ann = user(&c, &admin, "ann", "user").await;
    let bob = user(&c, &admin, "bob", "guest").await;

    assert_eq!(c.handle(json!({ "type": "PING" })).await["userPrefs"], json!(true), "the handshake offers the store");
    assert_eq!(c.handle(json!({ "type": "PREFS_GET" })).await["kind"], json!("unauthenticated"));
    assert_eq!(c.handle(json!({ "type": "PREFS_SET", "prefs": { "theme": "warm" } })).await["kind"], json!("unauthenticated"));

    // Never set: every value null — not "system", not "top". The choices come along.
    let r = get(&c, &ann).await;
    assert_eq!(r["user"], json!("ann"));
    assert_eq!(r["prefs"], json!({ "menu": null, "theme": null, "opensOn": null }));
    assert_eq!(r["updatedAt"], json!(0));
    assert_eq!(r["choices"]["theme"], json!(["system", "light", "dark", "dark-blue", "warm"]));
    assert_eq!(r["choices"]["menu"], json!(["top", "left"]));
    assert_eq!(r["choices"]["opensOn"], json!(["last", "all"]));

    let r = set(&c, &ann, json!({ "theme": "warm", "menu": "left" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["prefs"], json!({ "menu": "left", "theme": "warm", "opensOn": null }));
    assert!(r["updatedAt"].as_u64().unwrap() > 0);

    // A guest keeps their own; ann's are not theirs to see, and the message cannot name a user.
    assert_eq!(get(&c, &bob).await["prefs"]["theme"], Value::Null);
    let r = set(&c, &bob, json!({ "opensOn": "all", "user": "ann" })).await;
    assert_eq!(r["kind"], json!("bad_message"), "{r}");
    let r = set(&c, &bob, json!({ "opensOn": "all" })).await;
    assert_eq!(r["prefs"]["opensOn"], json!("all"));
    assert_eq!(get(&c, &ann).await["prefs"]["opensOn"], Value::Null, "bob's choice is bob's");
    assert_eq!(get(&c, &bob).await["prefs"]["theme"], Value::Null, "ann's theme is ann's");

    // A value outside the choices refuses the whole patch: the valid half is not kept.
    let r = set(&c, &ann, json!({ "theme": "neon", "menu": "top" })).await;
    assert_eq!(r["kind"], json!("bad_message"), "{r}");
    assert!(r["message"].as_str().unwrap().contains("neon"));
    assert_eq!(get(&c, &ann).await["prefs"]["menu"], json!("left"));
    assert_eq!(set(&c, &ann, json!({})).await["kind"], json!("bad_message"));
    assert_eq!(c.handle(json!({ "type": "PREFS_SET", "session": ann })).await["kind"], json!("bad_message"), "no prefs object");

    // null unsets one value and leaves the rest.
    let r = set(&c, &ann, json!({ "menu": null })).await;
    assert_eq!(r["prefs"], json!({ "menu": null, "theme": "warm", "opensOn": null }));

    // Kept on disk, 0600, and back after a restart.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.0.join("user-prefs.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    drop(c);
    let c = core(&dir);
    let ann = login(&c, "ann", PASSWORD).await;
    assert_eq!(get(&c, &ann).await["prefs"]["theme"], json!("warm"));
}

#[tokio::test]
async fn the_edition_without_accounts_has_one_person() {
    let dir = TempDir::new("prefs-portable");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PREFS_SET", "prefs": { "theme": "dark-blue" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["user"], json!("local"));
    assert_eq!(c.handle(json!({ "type": "PREFS_GET" })).await["prefs"]["theme"], json!("dark-blue"));
}
