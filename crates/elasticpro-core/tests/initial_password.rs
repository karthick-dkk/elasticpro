//! The operator's override for the first password, through a real core.
//!
//! One test in its own binary on purpose: it sets a process-wide environment variable,
//! and every other test in a shared binary would see it.

mod support;

use elasticpro_core::auth::{Edition, DEFAULT_PASSWORD, INITIAL_PASSWORD_ENV};
use elasticpro_core::Core;
use serde_json::json;
use support::TempDir;

#[tokio::test]
async fn an_override_file_is_honoured_and_an_unusable_one_stops_the_start() {
    let secrets = TempDir::new("initpw-secrets");

    // Honoured: that password opens the account, not fenced, and the shipped one does not.
    std::fs::write(secrets.join("good"), "operator-picked-password\n").unwrap();
    std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join("good"));
    let dir = TempDir::new("initpw-good");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": "operator-picked-password" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["caller"]["mustChange"], json!(false));
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": DEFAULT_PASSWORD })).await;
    assert_eq!(r["ok"], json!(false), "the shipped password must not open an install given its own: {r}");

    assert!(c.startup_refusal().is_none());

    // Too short, empty or missing: no account at all and a reason to refuse to start that
    // names the setting — never the shipped password the operator set the file to avoid.
    std::fs::write(secrets.join("short"), "tiny\n").unwrap();
    std::fs::write(secrets.join("empty"), "").unwrap();
    for name in ["short", "empty", "missing"] {
        std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join(name));
        let dir = TempDir::new("initpw-bad");
        let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
        let why = c.startup_refusal().unwrap_or_else(|| panic!("{name}: the core must refuse to start"));
        assert!(why.contains(INITIAL_PASSWORD_ENV), "{name}: {why}");
        let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": DEFAULT_PASSWORD })).await;
        assert_eq!(r["ok"], json!(false), "{name}: the shipped password must not open it: {r}");
        assert!(!dir.0.join("users.json").exists(), "{name}: no accounts file is written");
    }

    // An install that already has its accounts never reads the file, so a file removed or
    // broken after the first start does not stop it.
    std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join("good"));
    let dir = TempDir::new("initpw-later");
    drop(Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1));
    std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join("missing"));
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    assert!(c.startup_refusal().is_none());
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": "operator-picked-password" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    std::env::remove_var(INITIAL_PASSWORD_ENV);
}
