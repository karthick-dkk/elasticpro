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
async fn an_override_file_is_honoured_and_a_short_one_is_refused() {
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

    // Too short: refused, and the install still gets the shipped password rather than an
    // empty accounts store anyone could bootstrap.
    std::fs::write(secrets.join("short"), "tiny\n").unwrap();
    std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join("short"));
    let dir = TempDir::new("initpw-short");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": "tiny" })).await;
    assert_eq!(r["ok"], json!(false), "a too-short override must not become the password: {r}");
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": DEFAULT_PASSWORD })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(c.handle(json!({ "type": "WHOAMI" })).await["needsBootstrap"], json!(false));

    std::env::remove_var(INITIAL_PASSWORD_ENV);
}
