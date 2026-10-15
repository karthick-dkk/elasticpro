//! `defaults.tls: insecure` — one switch, in the config file, that accepts every certificate.
//!
//! A core started with its own config file takes the switch from that file and from nowhere
//! else: a page cannot turn certificate checking off by saying so in PRIME. One test in this
//! file, because the config path is process-wide ($ELASTICPRO_CONFIG).

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::json;
use support::tls::{self_signed, TlsServer};
use support::TempDir;

#[tokio::test]
async fn the_config_file_switch_accepts_every_certificate_and_lists_what_it_let_through() {
    let dir = TempDir::new("accept-all");
    let srv = TlsServer::start(&self_signed("localhost")).await;
    let path = dir.join("clusters.yaml");
    let write = |tls: &str| std::fs::write(&path, format!(
        "defaults: {{ tls: {tls} }}\nclusters:\n  - {{ name: es, url: \"{}\", tls: system }}\n", srv.url())).unwrap();
    write("auto");
    std::env::set_var("ELASTICPRO_CONFIG", &path);
    let c = Core::new(Some(dir.0.clone()), Edition::Portable);

    // The cluster asks for strict checking, and the page claims the switch is on: with a
    // config file, the page is not believed.
    let prime = json!({ "type": "PRIME", "acceptAllCertificates": true, "clusters": [
        { "id": "es", "name": "es", "url": srv.url(), "tls": "system", "authHeader": "Basic ZWxhc3RpYzpzZWNyZXQ=" } ] });
    c.handle(prime.clone()).await;
    let get = || c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" }));
    let r = get().await;
    assert_eq!(r["ok"], json!(false), "a page cannot switch checking off: {r}");
    assert_eq!(srv.hits().len(), 0, "nothing was sent to the unchecked certificate");

    // The admin sets Defaults → Certificates to insecure: every cluster, whatever its own tls.
    write("insecure");
    let pins = c.handle(json!({ "type": "PINS" })).await;
    assert_eq!(pins["pins"]["acceptAll"], json!(true), "{pins}");
    assert_eq!(get().await["ok"], json!(true), "tls: system on the cluster is overridden by the switch");
    let pins = c.handle(json!({ "type": "PINS" })).await;
    let acc = pins["pins"]["accepted"].as_array().expect("accepted").clone();
    assert_eq!(acc.len(), 1, "one entry for the one certificate: {pins}");
    assert_eq!(acc[0]["kind"], json!("certificate"));
    assert_eq!(acc[0]["target"], json!(srv.host_key()));
    assert_eq!(acc[0]["clusters"][0]["id"], json!("es"), "named by the cluster it serves");
    assert!(!acc[0]["reason"].as_str().unwrap().is_empty(), "and why it would have stopped");
    // A second request is the same certificate: still one entry.
    get().await;
    let again = c.handle(json!({ "type": "PINS" })).await;
    assert_eq!(again["pins"]["accepted"].as_array().unwrap().len(), 1);

    // A config that no longer parses fails closed: checking is back on.
    std::fs::write(&path, "defaults: { tls: insecure\n  broken: [").unwrap();
    let pins = c.handle(json!({ "type": "PINS" })).await;
    assert_eq!(pins["pins"]["acceptAll"], json!(false), "a broken file must not leave the switch on: {pins}");
    write("insecure");
    assert_eq!(c.handle(json!({ "type": "PINS" })).await["pins"]["acceptAll"], json!(true));

    // Back to auto: checked again, and the list is gone.
    write("auto");
    let pins = c.handle(json!({ "type": "PINS" })).await;
    assert_eq!(pins["pins"]["acceptAll"], json!(false));
    assert_eq!(pins["pins"]["accepted"], json!([]));
    assert_eq!(get().await["ok"], json!(false), "the switch off restores the cluster's own strict setting");
}
