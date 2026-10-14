//! A cluster host on an earlier template of the same family is still a cluster, and a host
//! that carries the cluster macros on no cluster template is named, not silently dropped.
//!
// Regression: ISSUE-001 — the sync counted only hosts on "Elasticsearch Cluster by HTTP EP";
// a site whose cluster host sat on an earlier template of that family got "last sync OK —
// 0 cluster hosts" on ElasticPro's side and no ES server under its client on Zabbix's, with
// nothing on either page saying why.
// Found by /qa on 2026-10-14
// Report: .gstack/qa-reports/qa-report-zabbix-link-2026-10-14.md

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::{TempDir, TestServer};

#[tokio::test]
async fn an_earlier_template_of_the_family_is_found_and_a_stray_host_is_named() {
    let zbx = TestServer::with(move |hit| {
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let p = &b["params"];
        let m = |k: &str, v: &str| json!({ "macro": k, "value": v, "type": "0" });
        let ep = json!({ "templateid": "900", "host": "Elasticsearch Cluster by HTTP EP", "macros": [] });
        let older = json!({ "templateid": "902", "host": "Elasticsearch Cluster by HTTP (earlier import)", "macros": [m("{$ELASTICSEARCH.PORT}", "9200")] });
        let result = match b["method"].as_str().unwrap() {
            // By exact name: the EP template (no hosts on it) and Cluster Management's jump template is absent.
            "template.get" if p.get("filter").is_some() => json!([ep]),
            // By the family's name: both generations.
            "template.get" if p["search"]["host"] == json!("Elasticsearch Cluster by HTTP") => json!([ep, older]),
            "template.get" => json!([]),
            "usermacro.get" if p["globalmacro"] == json!(true) => json!([]),
            // Every host-level {$ELASTICSEARCH.HOST}: the cluster on the earlier template, and a stray.
            "usermacro.get" => json!([{ "hostid": "11" }, { "hostid": "12" }]),
            "host.get" if p["templateids"] == json!(["900"]) => json!([]),
            "host.get" if p["templateids"] == json!(["902"]) => json!([
                { "hostid": "11", "host": "Local-ES-Cluster", "name": "Local-ES-Cluster", "hostgroups": [{ "groupid": "30" }],
                  "macros": [m("{$ELASTICSEARCH.HOST}", "10.0.0.7"), m("{$ELASTICSEARCH.SCHEME}", "http"), m("{$GRP.CLIENT}", "Local")] }]),
            "host.get" if p["hostids"].is_array() => json!([
                { "hostid": "12", "host": "odd-one", "name": "odd-one", "parentTemplates": [{ "host": "Some other template" }] }]),
            "usergroup.get" => json!([]),
            other => panic!("unexpected Zabbix call {other} {p}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await;

    let dir = TempDir::new("zbx-family");
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    let data = TempDir::new("zbx-family-data");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);

    let sync = c.zabbix_sync().await;
    assert_eq!(sync["ok"], json!(true), "{sync}");
    assert_eq!(sync["clusters"], json!(1), "the host on the earlier template is a cluster: {sync}");
    // Which templates were searched, and what each held — what "0 cluster hosts" never said.
    let tpls = sync["templates"].as_array().expect("the sync names the templates it read");
    assert!(tpls.iter().any(|t| t["name"] == json!("Elasticsearch Cluster by HTTP EP") && t["hosts"] == json!(0)), "{sync}");
    assert!(tpls.iter().any(|t| t["name"] == json!("Elasticsearch Cluster by HTTP (earlier import)") && t["hosts"] == json!(1)), "{sync}");
    // The stray host is named, with the template it is on and the way out.
    let skipped = sync["skipped"].to_string();
    assert!(skipped.contains("odd-one") && skipped.contains("Some other template"), "{sync}");
    assert!(!skipped.contains("Local-ES-Cluster"), "a host that was found is not also skipped: {sync}");
}
