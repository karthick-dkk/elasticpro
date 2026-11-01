//! A wall measuring a cluster that names no delay fields of its own — a Zabbix host, whose
//! spec carries none — is held to the clusters file's `defaults:` (timeField, delayFields), the
//! same place the UI resolves them from (config.js normalize, log-delay.js resolveFields): the
//! measurement the wall builds from those is accepted, a body naming anything else refused.
//!
//! Its own binary: the clusters file is process-wide ($ELASTICPRO_CONFIG).

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::fleet::events::Reauth;
use elasticpro_core::zbx_link::ServerZbx;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::{TempDir, TestServer};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cluster_with_no_delay_fields_is_measured_with_the_clusters_file_defaults() {
    let dir = TempDir::new("play-delay-file");
    let es = TestServer::with(|_| (200, r#"{"aggregations":{"devices":{"buckets":[]}}}"#.into())).await;
    let path = dir.join("clusters.yaml");
    // Defaults that are not the shipped ones: device fw_name, arrival `arrived`, event time `evt`.
    std::fs::write(&path, format!(
        "defaults:\n  logIndexPattern: \"fw-*\"\n  timeField: arrived\n  delayFields: {{ device: fw_name, eventTime: [evt], metadata: [site] }}\n\
         clusters:\n  - {{ name: own, url: \"{}\" }}\n", es.url())).unwrap();
    std::env::set_var("ELASTICPRO_CONFIG", &path);
    let server = ServerZbx { trusted_proxies: Some(vec!["127.0.0.1/32".into()]), ..Default::default() };
    let c = Core::new_with_server_zbx(Some(dir.0.clone()), Edition::Hosted, 1, server);
    let login = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = login["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": "correct-horse-battery" })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    // A cluster primed as the core holds a Zabbix host: no pattern, no time field, no delay fields.
    let r = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": true, "clusters": [{ "id": "z1", "url": es.url() }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let link = c.handle(json!({ "type": "PLAY_LINK_CREATE", "session": s, "name": "Wall", "clusters": ["z1"] })).await;
    let secret = link["secret"].as_str().unwrap().to_string();
    let from: Option<std::net::IpAddr> = Some("10.1.1.1".parse().unwrap());
    let ex = c.handle_as_from_at(json!({ "type": "PLAY_EXCHANGE", "secret": secret }), None, Reauth::None, from).await;
    let tok = ex["session"].as_str().unwrap().to_string();
    let send = |body: Value| {
        let c = c.clone();
        let tok = tok.clone();
        async move {
            let msg = json!({ "type": "ES", "session": tok, "clusterId": "z1", "method": "POST",
                "path": "/fw-*/_search?ignore_unavailable=true&allow_no_indices=true", "body": body.to_string() });
            let caller = c.caller_for_session(&tok);
            c.handle_as_from_at(msg, caller, Reauth::Session(tok.clone()), from).await
        }
    };
    // What the wall builds (log-delay.js buildSearchBody) from those defaults.
    let body = |device: &str, arrival: &str, source: Value| json!({
        "size": 0,
        "query": { "bool": { "filter": [{ "range": { arrival: { "gte": "now-24h", "lte": "now", "format": "strict_date_optional_time" } } }] } },
        "aggs": { "devices": { "terms": { "field": device, "size": 500, "order": { "_count": "desc" } },
            "aggs": { "latest": { "top_hits": { "size": 1, "sort": [{ arrival: { "order": "desc" } }], "_source": source } } } } },
    });
    let ok = send(body("fw_name.keyword", "arrived", json!(["arrived", "evt", "site"]))).await;
    assert_eq!(ok["ok"], json!(true), "the clusters file's delay fields: {ok}");
    let mut late = body("fw_name.keyword", "arrived", json!(["arrived", "evt"]));
    late["query"]["bool"]["filter"].as_array_mut().unwrap().push(json!({ "terms": { "fw_name.keyword": ["fw-01"] } }));
    assert_eq!(send(late).await["ok"], json!(true), "and the late list's re-check");
    // The shipped fields, and fields of the wall's own choosing: not this cluster's.
    for (why, b) in [
        ("the shipped device field", body("src_hostname.keyword", "arrived", json!(["arrived"]))),
        ("the shipped arrival field", body("fw_name.keyword", "@timestamp", json!(["@timestamp"]))),
        ("another _source field", body("fw_name.keyword", "arrived", json!(["arrived", "user.password"]))),
        ("another terms field", body("user.name.keyword", "arrived", json!(["arrived"]))),
    ] {
        let r = send(b).await;
        assert_eq!(r["kind"], json!("forbidden"), "{why}: {r}");
    }
}
