//! The message API the UI depends on. Every one of these shapes is read by a page in
//! `ui/js/`, so a change here is a change to the UI's contract.

mod support;

use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

fn core(dir: &TempDir) -> std::sync::Arc<Core> {
    Core::new(Some(dir.0.clone()), elasticpro_core::auth::Edition::Portable)
}

#[tokio::test]
async fn ping_describes_an_unprimed_core() {
    let dir = TempDir::new("ping");
    let res = core(&dir).handle(json!({ "type": "PING" })).await;

    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["primed"], json!(false), "nothing primed yet");
    assert_eq!(res["readOnly"], json!(true), "read-only is the default, not an opt-in");
    assert_eq!(res["writesUnlocked"], json!(false), "a session always starts locked");
    assert_eq!(res["desktop"], json!(true));
    assert_eq!(res["version"], json!(elasticpro_core::VERSION));
    assert_eq!(res["clusters"], json!([]));
    assert_eq!(res["tunnels"], json!([]));
    assert!(res["defaultConfigPath"].as_str().unwrap().ends_with("config_cluster.json"));
}

#[tokio::test]
async fn unknown_message_types_are_named_not_swallowed() {
    let dir = TempDir::new("unknown");
    let res = core(&dir).handle(json!({ "type": "DROP_EVERYTHING" })).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("bad_message"));
    assert!(res["message"].as_str().unwrap().contains("DROP_EVERYTHING"));
}

#[tokio::test]
async fn prime_then_ping_then_forget() {
    let dir = TempDir::new("prime");
    let c = core(&dir);

    let res = c
        .handle(json!({ "type": "PRIME", "clusters": [
            { "id": "a", "url": "https://a.example:9200" },
            { "id": "b", "url": "https://b.example:9200" },
        ]}))
        .await;
    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["count"], json!(2));
    assert_eq!(res["readOnly"], json!(true));

    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["primed"], json!(true));
    let mut ids: Vec<&str> = ping["clusters"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    ids.sort();
    assert_eq!(ids, ["a", "b"]);

    assert_eq!(c.handle(json!({ "type": "FORGET" })).await["ok"], json!(true));
    assert_eq!(c.handle(json!({ "type": "PING" })).await["primed"], json!(false));
}

#[tokio::test]
async fn read_only_can_only_be_turned_off_explicitly() {
    let dir = TempDir::new("ro");
    let c = core(&dir);

    // absent, null and true all mean read-only
    for v in [json!(null), json!(true)] {
        let res = c.handle(json!({ "type": "PRIME", "clusters": [], "readOnly": v })).await;
        assert_eq!(res["readOnly"], json!(true), "readOnly:{v} must stay read-only");
    }
    let res = c.handle(json!({ "type": "PRIME", "clusters": [] })).await;
    assert_eq!(res["readOnly"], json!(true), "an absent readOnly must stay read-only");

    let res = c.handle(json!({ "type": "PRIME", "clusters": [], "readOnly": false })).await;
    assert_eq!(res["readOnly"], json!(false), "only an explicit false lifts it");
}

#[tokio::test]
async fn a_malformed_prime_is_rejected_without_disturbing_the_current_one() {
    let dir = TempDir::new("badprime");
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "a", "url": "https://a:9200" }] })).await;

    let res = c.handle(json!({ "type": "PRIME", "clusters": "not-a-list" })).await;
    assert_eq!(res["ok"], json!(false));
    assert!(res["message"].as_str().unwrap().contains("bad PRIME"));

    assert_eq!(c.handle(json!({ "type": "PING" })).await["clusters"], json!(["a"]));
}

#[tokio::test]
async fn es_without_a_prime_asks_to_be_re_primed() {
    let dir = TempDir::new("noprime");
    let res = core(&dir).handle(json!({ "type": "ES", "clusterId": "ghost", "path": "/" })).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("no_creds"));
}

#[tokio::test]
async fn a_cluster_routed_via_an_undefined_jump_host_says_so() {
    let dir = TempDir::new("nojump");
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "a", "url": "https://a:9200", "via": "jumpwin" }
    ]}))
    .await;

    let res = c.handle(json!({ "type": "ES", "clusterId": "a", "path": "/" })).await;
    assert_eq!(res["kind"], json!("tunnel_error"));
    assert_eq!(res["tunnelKind"], json!("missing"));
    assert!(res["message"].as_str().unwrap().contains("jumpwin"));
}

/* ------------------------------- trust decisions ------------------------------- */

#[tokio::test]
async fn trusting_a_certificate_pins_it_and_survives_a_restart() {
    let dir = TempDir::new("trust");
    let fp = "AA:BB".to_string();

    let res = core(&dir)
        .handle(json!({ "type": "TRUST_CERT", "host": "es.internal:9200", "sha256": fp }))
        .await;
    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["sha256"], json!(fp));

    // a fresh Core over the same data dir reads pins.json back
    let c2 = core(&dir);
    let pins = c2.handle(json!({ "type": "PINS" })).await;
    assert_eq!(pins["pins"]["certs"]["es.internal:9200"]["sha256"], json!(fp));

    let res = c2.handle(json!({ "type": "UNTRUST_CERT", "host": "es.internal:9200" })).await;
    assert_eq!(res["ok"], json!(true));
    assert!(c2.handle(json!({ "type": "PINS" })).await["pins"]["certs"]["es.internal:9200"].is_null());
}

#[tokio::test]
async fn trust_refuses_when_there_is_no_certificate_to_trust() {
    let dir = TempDir::new("trustnone");
    // no sha256 given, and nothing has been seen for that host
    let res = core(&dir).handle(json!({ "type": "TRUST_CERT", "host": "never.seen:9200" })).await;

    assert_eq!(res["ok"], json!(false));
    assert!(res["message"].as_str().unwrap().contains("no certificate"));
}

#[tokio::test]
async fn pins_json_never_holds_a_credential() {
    let dir = TempDir::new("pinsecret");
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "a", "url": "https://a:9200", "authHeader": "Basic c3VwZXItc2VjcmV0" }
    ]}))
    .await;
    c.handle(json!({ "type": "TRUST_CERT", "host": "a:9200", "sha256": "AB" })).await;

    let text = std::fs::read_to_string(dir.join("pins.json")).expect("pins.json");
    assert!(!text.contains("c3VwZXItc2VjcmV0"), "pins.json must never carry the credential:\n{text}");
    assert!(!text.to_lowercase().contains("basic "), "pins.json must never carry an auth header:\n{text}");
}

#[tokio::test]
async fn reconnecting_an_unknown_tunnel_is_reported() {
    let dir = TempDir::new("retunnel");
    let res = core(&dir).handle(json!({ "type": "TUNNEL_RECONNECT", "jumpId": "nope" })).await;

    assert_eq!(res["ok"], json!(false));
    assert!(res["message"].as_str().unwrap().contains("nope"));
}

/* --------------------------------- config file --------------------------------- */

#[tokio::test]
async fn config_write_then_read_round_trips() {
    let dir = TempDir::new("cfg");
    let c = core(&dir);
    let path = dir.join("config_cluster.json");
    let text = r#"{"version":2,"clusters":[{"name":"a","url":"https://a:9200"}]}"#;

    let res = c.handle(json!({ "type": "CONFIG_WRITE", "path": path, "text": text })).await;
    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["bytes"], json!(text.len()));

    let res = c.handle(json!({ "type": "CONFIG_READ", "path": path })).await;
    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["text"], json!(text));
    assert_eq!(res["size"], json!(text.len()));
    assert!(res["lastModified"].as_u64().unwrap() > 0);

    // the .tmp staging file must not be left behind
    assert!(!dir.join("config_cluster.tmp").exists(), "atomic write left its temp file");
}

#[cfg(unix)]
#[tokio::test]
async fn a_written_config_is_readable_only_by_its_owner() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("cfgperm");
    let path = dir.join("config_cluster.json");
    core(&dir)
        .handle(json!({ "type": "CONFIG_WRITE", "path": path, "text": "{}" }))
        .await;

    let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "the config may hold a sealed credential; 0600, got {mode:o}");
}

#[tokio::test]
async fn config_read_of_a_missing_file_explains_itself() {
    let dir = TempDir::new("cfgmissing");
    let path = dir.join("not-there.json");
    let res = core(&dir).handle(json!({ "type": "CONFIG_READ", "path": path })).await;

    assert_eq!(res["ok"], json!(false));
    assert!(res["message"].as_str().unwrap().contains("cannot read"));
}

#[tokio::test]
async fn config_write_without_a_path_is_refused() {
    let dir = TempDir::new("cfgnopath");
    let res = core(&dir).handle(json!({ "type": "CONFIG_WRITE", "text": "{}" })).await;
    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["message"], json!("no path"));
}

/* ----------------------------- seal / open secrets ----------------------------- */

#[tokio::test]
async fn seal_and_open_round_trip_under_the_master_password() {
    let dir = TempDir::new("seal");
    let c = core(&dir);

    let sealed = c.handle(json!({ "type": "SEAL", "plain": "hunter2", "master": "correct horse" })).await;
    assert_eq!(sealed["ok"], json!(true));
    let value = sealed["value"].as_str().unwrap().to_string();
    assert!(value.starts_with("enc:v1:pbkdf2-sha512:"), "unexpected envelope: {value}");
    assert!(!value.contains("hunter2"));

    let opened = c.handle(json!({ "type": "OPEN", "value": value, "master": "correct horse" })).await;
    assert_eq!(opened["ok"], json!(true));
    assert_eq!(opened["plain"], json!("hunter2"));
}

#[tokio::test]
async fn opening_with_the_wrong_master_is_told_apart_from_a_malformed_value() {
    let dir = TempDir::new("seal2");
    let c = core(&dir);
    let value = c.handle(json!({ "type": "SEAL", "plain": "hunter2", "master": "right" })).await["value"]
        .as_str()
        .unwrap()
        .to_string();

    let wrong = c.handle(json!({ "type": "OPEN", "value": value, "master": "WRONG" })).await;
    assert_eq!(wrong["ok"], json!(false));
    assert_eq!(wrong["kind"], json!("bad_master"), "a wrong password must not read as corruption");

    let junk = c.handle(json!({ "type": "OPEN", "value": "enc:v1:pbkdf2-sha512:600000:@:@:@", "master": "x" })).await;
    assert_eq!(junk["ok"], json!(false));
    assert_eq!(junk["kind"], json!("malformed"));
}

#[tokio::test]
async fn opening_a_plain_value_returns_it_and_flags_that_it_was_never_sealed() {
    let dir = TempDir::new("seal3");
    let res = core(&dir).handle(json!({ "type": "OPEN", "value": "plaintext", "master": "x" })).await;

    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["plain"], json!("plaintext"));
    assert_eq!(res["unsealed"], json!(true));
}

#[tokio::test]
async fn sealing_the_same_secret_twice_gives_different_ciphertext() {
    let dir = TempDir::new("seal4");
    let c = core(&dir);
    let one = seal(&c, "same", "master").await;
    let two = seal(&c, "same", "master").await;
    assert_ne!(one, two, "a fixed salt/nonce would leak that two clusters share a password");
}

async fn seal(c: &std::sync::Arc<Core>, plain: &str, master: &str) -> String {
    let v: Value = c.handle(json!({ "type": "SEAL", "plain": plain, "master": master })).await;
    v["value"].as_str().unwrap().to_string()
}

/// A config that is not there yet, and one that is there but broken, must be told apart.
///
/// The hosted stack sets ELASTICPRO_CONFIG unconditionally and the config file is
/// gitignored because it holds credentials, so the very first start always asks for a
/// file that does not exist. The UI shows a setup screen for the first and an error for
/// the second; it can only do that if the core says which this is.
#[tokio::test]
async fn a_missing_config_is_distinguishable_from_an_unreadable_one() {
    let dir = TempDir::new("config-read");
    let c = core(&dir);

    let missing = dir.0.join("not-created-yet.json");
    let res = c.handle(json!({ "type": "CONFIG_READ", "path": missing })).await;
    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("not_found"), "{res}");

    // A directory is readable metadata but not a file — a fault, not a fresh install.
    let res = c.handle(json!({ "type": "CONFIG_READ", "path": dir.0.clone() })).await;
    assert_eq!(res["ok"], json!(false));
    assert_ne!(res["kind"], json!("not_found"), "a directory is not a missing file: {res}");

    // And a real one still reads.
    let good = dir.0.join("cfg.json");
    std::fs::write(&good, r#"{"version":2,"clusters":[]}"#).unwrap();
    let res = c.handle(json!({ "type": "CONFIG_READ", "path": good })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert!(res["text"].as_str().unwrap().contains("\"version\":2"));
}

/// Saving a config must not change who can read it.
///
/// The hosted stack shares config_cluster.json between the container and the host user,
/// so the file is deliberately group-readable. A write that forced 0600 back on locked
/// the operator out of their own file the first time they saved from the UI.
#[cfg(unix)]
#[tokio::test]
async fn writing_a_config_preserves_the_mode_it_found() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("config-mode");
    let c = core(&dir);
    let path = dir.0.join("cfg.json");

    // A file the operator has deliberately made group-readable.
    std::fs::write(&path, "{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();

    let res = c.handle(json!({ "type": "CONFIG_WRITE", "path": path, "text": "{\"version\":2}" })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o660, "the mode was reset to {mode:o}");
    assert!(std::fs::read_to_string(&path).unwrap().contains("version"));

    // A file that did not exist is still created private.
    let fresh = dir.0.join("new.json");
    c.handle(json!({ "type": "CONFIG_WRITE", "path": fresh, "text": "{}" })).await;
    let mode = std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "a new config should default to owner-only, got {mode:o}");
}
