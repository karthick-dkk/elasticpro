//! Cluster type, ULM bucket and whether SLM is expected (cluster_meta.rs), end to end against
//! a fake Zabbix:
//!   * a Zabbix cluster with no entry takes its type from the host tag `elasticpro:type`;
//!   * CLUSTER_META_GET is a user's and shows only the clusters they see;
//!   * CLUSTER_META_SET is an admin's, validates type / bucket / slm, is kept 0600 on disk,
//!     is audited, wins over the tag, and `meta: null` hands the cluster back to the tag;
//!   * the desktop build keeps none of it on the server.
//!
//! One test function: the Zabbix API is configured from the environment, which is process-wide.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{TempDir, TestServer};

const SECRET: &str = "integration-secret-0123456789abcdef-xyz";

async fn zsession(c: &Arc<Core>, user: &str, ty: i64, groups: &[&str]) -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let body = serde_json::to_vec(&json!({ "username": user, "zabbix_user_type": ty, "groups": groups,
        "ts": ts.as_secs(), "nonce": format!("nonce-{}-{user}", ts.as_nanos()) })).unwrap();
    let (_, out) = c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body));
    c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await["session"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn cluster_type_is_seeded_from_the_zabbix_tag_and_set_by_an_admin() {
    let host_gets = Arc::new(Mutex::new(Vec::<Value>::new()));
    let hg = host_gets.clone();
    let zbx = TestServer::with(move |hit| {
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let p = &b["params"];
        let m = |k: &str, v: &str| json!({ "macro": k, "value": v, "type": "0" });
        let result = match b["method"].as_str().unwrap() {
            "template.get" => json!([{ "templateid": "900", "host": "Elasticsearch Cluster by HTTP EP", "macros": [] }]),
            "usermacro.get" => json!([]),
            "host.get" if p["templateids"] == json!(["900"]) => {
                hg.lock().unwrap().push(p.clone());
                json!([
                    { "hostid": "1", "host": "ci-host", "name": "ci-host", "hostgroups": [{ "groupid": "30" }],
                      "tags": [{ "tag": "client", "value": "acme" }, { "tag": "elasticpro:type", "value": "CI" }],
                      "macros": [m("{$ELASTICSEARCH.HOST}", "10.0.0.1"), m("{$ELASTICSEARCH.SCHEME}", "http"), m("{$ELASTICSEARCH.PASSWORD}", "pw")] },
                    { "hostid": "2", "host": "plain", "name": "plain", "hostgroups": [{ "groupid": "40" }], "tags": [],
                      "macros": [m("{$ELASTICSEARCH.HOST}", "10.0.0.2"), m("{$ELASTICSEARCH.SCHEME}", "http"), m("{$ELASTICSEARCH.PASSWORD}", "pw")] },
                ])
            }
            "host.get" => json!([]),
            "usergroup.get" => json!([
                { "name": "G-ci", "users_status": "0", "hostgroup_rights": [{ "id": "30", "permission": "2" }] },
            ]),
            // The sync re-checks roles from live groups; nobody from Zabbix here, so nothing moves.
            "user.get" => json!([]),
            other => panic!("unexpected Zabbix call {other} {p}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await;

    let dir = TempDir::new("cluster-meta");
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    let data = TempDir::new("cluster-meta-data");
    std::fs::write(data.join("config_cluster.json"), r#"{"zabbix":{"scopeUsersByGroup":true}}"#).unwrap();
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();

    let sync = c.zabbix_sync().await;
    assert_eq!(sync["inUse"], json!(2), "{sync}");
    // The tag rides on the host.get the sync already makes: no extra call.
    let gets = host_gets.lock().unwrap().clone();
    assert_eq!(gets.len(), 1, "one host.get per cluster template, as before");
    assert_eq!(gets[0]["selectTags"], json!(["tag", "value"]), "{}", gets[0]);

    let admin = zsession(&c, "sara", 3, &[]).await;
    let oper = zsession(&c, "otto", 2, &[]).await;
    let user = zsession(&c, "uma", 1, &["G-ci"]).await;

    // --- seeded from the tag; nothing for a cluster with no tag and no entry.
    let all = c.handle(json!({ "type": "CLUSTER_META_GET", "session": admin })).await;
    assert_eq!(all["ok"], json!(true), "{all}");
    assert_eq!(all["clusters"]["zbx-ci-host"]["type"], json!("ci"), "{all}");
    assert_eq!(all["clusters"]["zbx-ci-host"]["source"], json!("zabbix-tag"));
    assert!(all["clusters"].get("zbx-plain").is_none(), "no tag, no entry: the page's On-Prem defaults: {all}");
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": admin })).await;
    assert!(list["clusters"].as_array().unwrap().iter().any(|x| x["_id"] == "zbx-ci-host" && x["type"] == "ci"), "{list}");

    // --- a user reads only what they see.
    let mine = c.handle(json!({ "type": "CLUSTER_META_GET", "session": user })).await;
    assert_eq!(mine["ok"], json!(true), "{mine}");
    assert_eq!(mine["clusters"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["zbx-ci-host"], "{mine}");

    // --- setting is an admin's.
    let meta = json!({ "type": "DI", "ulm": { "enabled": true, "bucket": "acme-logs" }, "slm": "none" });
    for (who, s) in [("user", &user), ("operator", &oper)] {
        let r = c.handle(json!({ "type": "CLUSTER_META_SET", "session": s, "clusterId": "zbx-plain", "meta": meta })).await;
        assert_eq!(r["ok"], json!(false), "{who}: {r}");
    }
    assert!(!data.join("cluster-meta.json").exists(), "nothing written by a refused set");

    // --- validated.
    for (bad, why) in [
        (json!({ "type": "cloud" }), "type"),
        (json!({ "type": "ci", "ulm": { "enabled": true, "bucket": "Acme_Logs" } }), "bucket"),
        (json!({ "type": "ci", "ulm": { "bucket": "ab" } }), "bucket length"),
        (json!({ "type": "ci", "slm": "maybe" }), "slm"),
    ] {
        let r = c.handle(json!({ "type": "CLUSTER_META_SET", "session": admin, "clusterId": "zbx-plain", "meta": bad })).await;
        assert_eq!(r["kind"], json!("bad_request"), "{why}: {r}");
    }
    let r = c.handle(json!({ "type": "CLUSTER_META_SET", "session": admin, "clusterId": "nope", "meta": meta })).await;
    assert_eq!(r["kind"], json!("forbidden"), "an unknown cluster: {r}");

    // --- kept, 0600, answered with the whole visible set.
    let r = c.handle(json!({ "type": "CLUSTER_META_SET", "session": admin, "clusterId": "zbx-plain", "meta": meta })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let e = &r["clusters"]["zbx-plain"];
    assert_eq!((e["type"].clone(), e["ulm"]["enabled"].clone(), e["ulm"]["bucket"].clone(), e["slm"].clone(), e["source"].clone(), e["setBy"].clone()),
               (json!("di"), json!(true), json!("acme-logs"), json!("none"), json!("set"), json!("sara@zabbix")), "{r}");
    let p = data.join("cluster-meta.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(on_disk["zbx-plain"]["ulm"]["bucket"], json!("acme-logs"));

    // --- an entry wins over the tag; forgetting it hands the cluster back to the tag.
    let r = c.handle(json!({ "type": "CLUSTER_META_SET", "session": admin, "clusterId": "zbx-ci-host", "meta": { "type": "onprem" } })).await;
    assert_eq!(r["clusters"]["zbx-ci-host"]["type"], json!("onprem"), "{r}");
    assert!(r["clusters"]["zbx-ci-host"].get("slm").is_none(), "unsaid follows the type: {r}");
    let r = c.handle(json!({ "type": "CLUSTER_META_SET", "session": admin, "clusterId": "zbx-ci-host", "meta": null })).await;
    assert_eq!((r["clusters"]["zbx-ci-host"]["type"].clone(), r["clusters"]["zbx-ci-host"]["source"].clone()),
               (json!("ci"), json!("zabbix-tag")), "{r}");

    // --- survives a restart.
    let again = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    again.zabbix_sso().set_secret(SECRET).unwrap();
    again.zabbix_sync().await;
    let a2 = zsession(&again, "sara", 3, &[]).await;
    let r = again.handle(json!({ "type": "CLUSTER_META_GET", "session": a2 })).await;
    assert_eq!(r["clusters"]["zbx-plain"]["ulm"]["bucket"], json!("acme-logs"), "{r}");

    // --- the desktop build keeps it in the config file, not here.
    let ddir = TempDir::new("cluster-meta-desktop");
    let desk = Core::new_with_rounds(Some(ddir.0.clone()), Edition::Portable, 1);
    let r = desk.handle(json!({ "type": "CLUSTER_META_GET" })).await;
    assert_eq!(r["kind"], json!("not_available"), "{r}");
    assert!(!ddir.join("cluster-meta.json").exists());
}
