//! The operator's override for the first password, through a real core.
//!
//! One test in its own binary on purpose: it sets a process-wide environment variable,
//! and every other test in a shared binary would see it.

mod support;

use elasticpro_core::auth::{Edition, INITIAL_PASSWORD_ENV, INITIAL_PASSWORD_FILE};
use elasticpro_core::Core;
use serde_json::json;
use support::TempDir;

#[tokio::test]
async fn an_override_file_is_honoured_and_a_short_one_is_refused() {
    let secrets = TempDir::new("initpw-secrets");

    // Honoured: that password opens the account, still behind the forced change, and no
    // second copy of it lands in the data directory.
    std::fs::write(secrets.join("good"), "operator-picked-password\n").unwrap();
    std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join("good"));
    let dir = TempDir::new("initpw-good");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    assert!(!dir.join(INITIAL_PASSWORD_FILE).exists());
    let r = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": "operator-picked-password" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["caller"]["mustChange"], json!(true));

    // Too short: refused, and the install still gets a random first password rather than
    // an empty accounts store anyone could bootstrap.
    std::fs::write(secrets.join("short"), "tiny\n").unwrap();
    std::env::set_var(INITIAL_PASSWORD_ENV, secrets.join("short"));
    let dir = TempDir::new("initpw-short");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let r = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": "tiny" })).await;
    assert_eq!(r["ok"], json!(false), "a too-short override must not become the password: {r}");
    let pw = support::first_password(&c);
    assert!(pw.chars().count() >= 20);
    let r = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": pw })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(c.handle(json!({ "type": "WHOAMI" })).await["needsBootstrap"], json!(false));

    std::env::remove_var(INITIAL_PASSWORD_ENV);
}
