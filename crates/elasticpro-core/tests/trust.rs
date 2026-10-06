//! Certificate trust — the decision the app takes out of the browser's hands.
//!
//! Every case here runs through a real TLS handshake against a real self-signed
//! certificate, because the claim being tested is about what rustls accepts.

mod support;

use elasticpro_core::Core;
use serde_json::json;
use support::tls::{self_signed, TlsServer};
use support::TempDir;

fn core(dir: &TempDir) -> std::sync::Arc<Core> {
    Core::new(Some(dir.0.clone()), elasticpro_core::auth::Edition::Portable)
}

async fn primed(dir: &TempDir, url: &str, tls: &str) -> std::sync::Arc<Core> {
    let c = core(dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "es", "url": url, "tls": tls, "authHeader": "Basic ZWxhc3RpYzpzZWNyZXQ=" }
    ]}))
    .await;
    c
}

async fn get(c: &std::sync::Arc<Core>) -> serde_json::Value {
    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await
}

#[tokio::test]
async fn an_unknown_certificate_is_shown_before_it_is_trusted() {
    let dir = TempDir::new("tofu");
    let cert = self_signed("localhost");
    let srv = TlsServer::start(&cert).await;
    let c = primed(&dir, &srv.url(), "auto").await;

    let res = get(&c).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("tls_untrusted"), "{res}");
    assert_eq!(res["cert"]["sha256"], json!(cert.sha256), "the UI needs the exact fingerprint to show");
    assert_eq!(res["cert"]["self_signed"], json!(true));
    assert!(!res["cert"]["subject"].as_str().unwrap().is_empty(), "the operator needs a subject to look at");
    let sans = res["cert"]["sans"].as_array().expect("sans");
    assert!(
        sans.iter().any(|s| s.as_str().unwrap_or("").contains("localhost")),
        "the names the certificate is valid for must be shown: {sans:?}"
    );
    assert!(!res["cert"]["not_after"].as_str().unwrap().is_empty(), "validity is part of the decision");
    assert!(res["pinned"].is_null(), "nothing is pinned yet");
    assert_eq!(srv.hits().len(), 0, "the credential must not be sent to an untrusted certificate");
}

#[tokio::test]
async fn trusting_it_once_is_enough_and_it_survives_a_restart() {
    let dir = TempDir::new("trustonce");
    let cert = self_signed("localhost");
    let srv = TlsServer::start(&cert).await;
    let c = primed(&dir, &srv.url(), "auto").await;
    assert_eq!(get(&c).await["kind"], json!("tls_untrusted"));

    // the operator presses Trust — the UI sends only the host; the core uses what it saw
    let t = c.handle(json!({ "type": "TRUST_CERT", "host": srv.host_key() })).await;
    assert_eq!(t["ok"], json!(true), "{t}");
    assert_eq!(t["sha256"], json!(cert.sha256));

    let res = get(&c).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(res["json"]["cluster_name"], json!("secured"));

    // a fresh Core over the same data dir does not ask again
    let c2 = primed(&dir, &srv.url(), "auto").await;
    assert_eq!(get(&c2).await["ok"], json!(true), "the pin must outlive the process");
}

#[tokio::test]
async fn a_changed_certificate_is_refused_and_the_credential_is_not_sent() {
    let dir = TempDir::new("mismatch");
    let first = self_signed("localhost");
    let srv = TlsServer::start(&first).await;
    let c = primed(&dir, &srv.url(), "auto").await;
    get(&c).await;
    c.handle(json!({ "type": "TRUST_CERT", "host": srv.host_key() })).await;
    assert_eq!(get(&c).await["ok"], json!(true));
    let good_hits = srv.hits().len();

    // the same address now presents a different certificate
    let second = self_signed("localhost");
    assert_ne!(first.sha256, second.sha256);
    srv.rotate_to(&second);

    let res = get(&c).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("tls_pin_mismatch"), "{res}");
    assert_eq!(res["pinned"], json!(first.sha256), "the UI shows which pin was expected");
    assert_eq!(res["cert"]["sha256"], json!(second.sha256), "…and which one arrived");
    assert!(res["message"].as_str().unwrap().contains("Credential not sent"));
    assert_eq!(srv.hits().len(), good_hits, "no request — so no credential — crossed the new certificate");
}

#[tokio::test]
async fn untrusting_then_trusting_the_new_certificate_recovers() {
    let dir = TempDir::new("rotate");
    let first = self_signed("localhost");
    let srv = TlsServer::start(&first).await;
    let c = primed(&dir, &srv.url(), "auto").await;
    get(&c).await;
    c.handle(json!({ "type": "TRUST_CERT", "host": srv.host_key() })).await;

    let second = self_signed("localhost");
    srv.rotate_to(&second);
    assert_eq!(get(&c).await["kind"], json!("tls_pin_mismatch"));

    c.handle(json!({ "type": "UNTRUST_CERT", "host": srv.host_key() })).await;
    // the certificate is unknown again, so it is offered rather than silently accepted
    let res = get(&c).await;
    assert_eq!(res["kind"], json!("tls_untrusted"), "untrusting must not auto-accept the new one");
    assert_eq!(res["cert"]["sha256"], json!(second.sha256));

    c.handle(json!({ "type": "TRUST_CERT", "host": srv.host_key() })).await;
    assert_eq!(get(&c).await["ok"], json!(true), "the rotated certificate now works");
}

#[tokio::test]
async fn tls_system_never_offers_to_pin() {
    let dir = TempDir::new("strict");
    let cert = self_signed("localhost");
    let srv = TlsServer::start(&cert).await;
    let c = primed(&dir, &srv.url(), "system").await;

    let res = get(&c).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("tls_error"), "strict mode must fail as TLS, not as a pin prompt: {res}");

    // and even an explicit pin does not rescue a `system` cluster
    c.handle(json!({ "type": "TRUST_CERT", "host": srv.host_key(), "sha256": cert.sha256 })).await;
    assert_eq!(get(&c).await["ok"], json!(false), "a pin must not weaken tls: system");
}

#[tokio::test]
async fn tls_insecure_accepts_anything_including_a_rotation() {
    let dir = TempDir::new("insecure");
    let first = self_signed("localhost");
    let srv = TlsServer::start(&first).await;
    let c = primed(&dir, &srv.url(), "insecure").await;

    assert_eq!(get(&c).await["ok"], json!(true), "lab mode connects without a decision");
    srv.rotate_to(&self_signed("localhost"));
    assert_eq!(get(&c).await["ok"], json!(true), "…and does not notice a change either");
}

#[tokio::test]
async fn a_pin_is_scoped_to_one_address() {
    let dir = TempDir::new("scope");
    let cert = self_signed("localhost");
    let a = TlsServer::start(&cert).await;
    let b = TlsServer::start(&cert).await;

    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "a", "url": a.url(), "tls": "auto" },
        { "id": "b", "url": b.url(), "tls": "auto" },
    ]}))
    .await;

    c.handle(json!({ "type": "ES", "clusterId": "a", "path": "/" })).await;
    c.handle(json!({ "type": "TRUST_CERT", "host": a.host_key() })).await;

    assert_eq!(c.handle(json!({ "type": "ES", "clusterId": "a", "path": "/" })).await["ok"], json!(true));
    let res = c.handle(json!({ "type": "ES", "clusterId": "b", "path": "/" })).await;
    assert_eq!(
        res["kind"],
        json!("tls_untrusted"),
        "the very same certificate at a different port is still an unmade decision"
    );
}
