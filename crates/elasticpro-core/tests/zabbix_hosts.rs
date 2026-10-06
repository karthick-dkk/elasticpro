//! Clusters that come from Zabbix hosts, end to end: a fake Zabbix API, a fake Vault and a
//! fake Elasticsearch, and the real core in between.
//!
//! One test function, because the Zabbix API and Vault are configured from the environment,
//! which is process-wide; the scenarios run in order against one core.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
async fn zabbix_hosts_become_clusters() {
    let es = TestServer::start().await;
    let es_url = es.url();
    let es_host = es_url.trim_start_matches("http://").split(':').next().unwrap().to_string();
    let es_port = es_url.rsplit(':').next().unwrap().to_string();

    // Vault: AppRole login, then one KV v2 secret. Can be switched off mid-test.
    let vault_up = Arc::new(AtomicBool::new(true));
    let up = vault_up.clone();
    // Each login issues tok-<n>; only the newest is accepted, so revoking is "log in again".
    let logins = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::new(AtomicUsize::new(0));
    let (lg, ac) = (logins.clone(), accepted.clone());
    let vault = TestServer::with(move |hit| {
        if !up.load(Ordering::SeqCst) {
            return (503, r#"{"errors":["Vault is sealed"]}"#.into());
        }
        if hit.path == "/v1/auth/approle/login" {
            let b: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
            if b["role_id"] == "role-1" && b["secret_id"] == "secret-1" {
                let n = lg.fetch_add(1, Ordering::SeqCst) + 1;
                ac.store(n, Ordering::SeqCst);
                return (200, format!(r#"{{"auth":{{"client_token":"tok-{n}","lease_duration":3600}}}}"#));
            }
            return (400, r#"{"errors":["invalid role or secret ID"]}"#.into());
        }
        let good = format!("tok-{}", ac.load(Ordering::SeqCst));
        if hit.path == "/v1/secret/data/elasticpro/vm-1" && hit.header("x-vault-token") == Some(good.as_str()) {
            return (200, r#"{"data":{"data":{"password":"s3cret"}}}"#.into());
        }
        (403, r#"{"errors":["permission denied"]}"#.into())
    }).await;

    // Zabbix: the cluster template, two hosts that are clusters and one that is not filled in.
    let (h, p) = (es_host.clone(), es_port.clone());
    let item_calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let ic = item_calls.clone();
    let zbx = TestServer::with(move |hit| {
        assert_eq!(hit.header("authorization"), Some("Bearer zbx-token"), "the API token must be sent");
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let m = |k: &str, v: &str, t: &str| json!({ "macro": k, "value": v, "type": t });
        let result = match b["method"].as_str().unwrap() {
            "template.get" => json!([{ "templateid": "900", "host": "Elasticsearch Cluster by HTTP EP", "macros": [
                m("{$ELASTICSEARCH.HOST}", "<SET ELASTICSEARCH HOST>", "0"), m("{$ELASTICSEARCH.PORT}", "9200", "0"),
                m("{$ELASTICSEARCH.SCHEME}", "https", "0"), m("{$ELASTICSEARCH.PASSWORD}", "", "1")] },
                // Cluster Management's template for a cluster behind a Windows jump host.
                { "templateid": "901", "host": "ElasticPro Elasticsearch via SSH jump host", "macros": [m("{$WJ.PORT}", "22", "0")] }]),
            "usermacro.get" => json!([]),
            "host.get" if b["params"]["templateids"] == json!(["901"]) => json!([
                { "hostid": "5", "host": "acme-ES-Cluster", "name": "acme-ES-Cluster", "hostgroups": [{ "groupid": "50" }],
                  "macros": [m("{$ELASTICSEARCH.HOST}", "10.1.0.5", "0"), m("{$ELASTICSEARCH.SCHEME}", "https", "0"),
                             m("{$WJ.HOST}", "jump-win.acme.local", "0"), m("{$GRP.CLIENT}", "acme", "0")] },
            ]),
            "host.get" => json!([
                { "hostid": "1", "host": "vm-1 cluster", "name": "vm-1 cluster", "hostgroups": [{ "groupid": "30" }],
                  "macros": [m("{$ELASTICSEARCH.HOST}", &h, "0"), m("{$ELASTICSEARCH.PORT}", &p, "0"),
                             m("{$ELASTICSEARCH.SCHEME}", "http", "0"), m("{$ELASTICSEARCH.USERNAME}", "elastic", "0"),
                             m("{$ELASTICSEARCH.PASSWORD}", "secret/elasticpro/vm-1:password", "2"), m("{$GRP.CLIENT}", "vm-1", "0")] },
                { "hostid": "2", "host": "legacy", "name": "legacy", "hostgroups": [{ "groupid": "40" }],
                  "macros": [m("{$ELASTICSEARCH.HOST}", "10.9.9.9", "0")] },
                { "hostid": "3", "host": "unfinished", "name": "unfinished", "hostgroups": [], "macros": [] },
            ]),
            "item.get" => {
                ic.lock().unwrap().push(b["params"].clone());
                json!([{ "key_": "es.cluster.status", "lastvalue": "1", "lastclock": "1790000000" },
                       { "key_": "es.version", "lastvalue": "8.19.3", "lastclock": "0" }])
            }
            "usergroup.get" => json!([
                { "name": "ES vm-1", "users_status": "0", "hostgroup_rights": [{ "id": "30", "permission": "2" }] },
                { "name": "Other", "users_status": "0", "hostgroup_rights": [{ "id": "40", "permission": "2" }] },
            ]),
            other => panic!("unexpected Zabbix call {other}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await;

    let dir = TempDir::new("zbx-hosts");
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::fs::write(dir.join("role-id"), "role-1").unwrap();
    std::fs::write(dir.join("secret-id"), "secret-1").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    std::env::set_var("ELASTICPRO_VAULT_ADDR", vault.url());
    std::env::set_var("ELASTICPRO_VAULT_ROLE_ID_FILE", dir.join("role-id"));
    std::env::set_var("ELASTICPRO_VAULT_SECRET_ID_FILE", dir.join("secret-id"));
    let data = TempDir::new("zbx-hosts-data");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();

    // --- a sync finds the hosts, and says which one is not a cluster yet
    let sync = c.zabbix_sync().await;
    assert_eq!(sync["ok"], json!(true), "{sync}");
    assert_eq!(sync["clusters"], json!(3), "the cluster behind the Windows jump host is found too");
    assert!(sync["skipped"].to_string().contains("unfinished"), "{sync}");

    let admin = zsession(&c, "sara", 3, &[]).await;
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": admin })).await;
    let vm1 = list["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-vm-1-cluster").unwrap().clone();
    assert_eq!(vm1["credential"], json!("vault"));
    assert_eq!(vm1["credentialOk"], json!(true));
    assert_eq!(vm1["url"], json!(es_url));
    assert!(!list.to_string().contains("s3cret"), "the password must never appear in a listing");
    // No jump host of ElasticPro's own matches the one Zabbix uses: said, not guessed.
    let acme = list["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-acme-es-cluster").unwrap().clone();
    assert_eq!(acme["via"], Value::Null);
    assert!(acme.to_string().contains("behind jump host jump-win.acme.local:22"), "{acme}");

    // --- the password from Vault is what Elasticsearch receives
    let r = c.handle(json!({ "type": "ES", "session": admin, "clusterId": "zbx-vm-1-cluster",
                             "method": "GET", "path": "/_cluster/health" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    use base64::Engine as _;
    let want = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("elastic:s3cret"));
    assert_eq!(es.last_hit().unwrap().header("authorization"), Some(want.as_str()));

    // --- a Secret macro is reported, not silently empty
    let legacy = list["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-legacy").unwrap().clone();
    assert_eq!(legacy["credential"], json!("secret-macro"));
    assert_eq!(legacy["credentialOk"], json!(false));
    assert!(legacy["notes"].to_string().contains("Vault macro"));

    // --- Zabbix permissions decide who sees what
    let mine = zsession(&c, "uma", 1, &["ES vm-1"]).await;
    let theirs = zsession(&c, "olga", 1, &["Nobody"]).await;
    let l = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": mine })).await;
    let ids: Vec<&str> = l["clusters"].as_array().unwrap().iter().map(|x| x["_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["zbx-vm-1-cluster"]);
    assert!(l["clusters"][0].get("zabbixGroups").is_none() && l["clusters"][0].get("notes").is_none(),
            "who can see a cluster and why it failed are an admin's business");
    assert_eq!(c.handle(json!({ "type": "ES", "session": mine, "clusterId": "zbx-vm-1-cluster",
                                "method": "GET", "path": "/_cluster/health" })).await["ok"], json!(true));
    assert_eq!(c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": theirs })).await["clusters"], json!([]));
    assert_eq!(c.handle(json!({ "type": "ES", "session": theirs, "clusterId": "zbx-vm-1-cluster",
                                "method": "GET", "path": "/" })).await["kind"], json!("forbidden"));
    assert_eq!(c.handle(json!({ "type": "ZABBIX_SYNC", "session": mine })).await["kind"], json!("forbidden"));

    // --- what Zabbix measured, for somebody who may see the cluster; not for anyone else
    let m = c.handle(json!({ "type": "ZABBIX_METRICS", "session": mine, "clusterId": "zbx-vm-1-cluster",
                             "keys": ["es.cluster.status", "es.version", "system.run[rm -rf /]"] })).await;
    assert_eq!(m["ok"], json!(true), "{m}");
    assert_eq!(m["items"]["es.cluster.status"]["value"], json!("1"));
    assert!(m["items"].get("es.version").is_none(), "an item that never received a value is unknown, not \"0\"");
    let asked = item_calls.lock().unwrap()[0]["filter"]["key_"].to_string();
    assert!(asked.contains("es.cluster.status") && !asked.contains("system.run"),
            "only es.* and elasticpro.* items may be asked for: {asked}");
    c.handle(json!({ "type": "ZABBIX_METRICS", "session": mine, "clusterId": "zbx-vm-1-cluster",
                     "keys": ["es.cluster.status", "es.version", "system.run[rm -rf /]"] })).await;
    assert_eq!(item_calls.lock().unwrap().len(), 1, "a second load within 30s is served from the cache");
    let no = c.handle(json!({ "type": "ZABBIX_METRICS", "session": theirs, "clusterId": "zbx-vm-1-cluster",
                              "keys": ["es.cluster.status"] })).await;
    assert_eq!(no["kind"], json!("forbidden"), "{no}");

    // --- Zabbix wins over a primed cluster with the same id
    let other = TestServer::start().await;
    let local = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(&c) })).await;
    let ls = local["session"].as_str().unwrap().to_string();
    c.handle(json!({ "type": "USER_SET_PASSWORD", "session": ls, "name": "elasticpro", "password": "correct-horse-battery" })).await;
    c.handle(json!({ "type": "PRIME", "session": ls, "clusters": [
        { "id": "zbx-vm-1-cluster", "url": other.url(), "authHeader": "Basic b3RoZXI6b3RoZXI=" }] })).await;
    c.handle(json!({ "type": "ES", "session": admin, "clusterId": "zbx-vm-1-cluster", "method": "GET", "path": "/" })).await;
    assert_eq!(other.connections(), 0, "a primed cluster must not shadow the Zabbix host with the same id");

    // --- a token Vault revoked early is replaced by signing in again, not reported as a failure
    accepted.store(0, Ordering::SeqCst);                 // no token is valid any more
    let before = logins.load(Ordering::SeqCst);
    c.zabbix_sync().await;
    assert_eq!(logins.load(Ordering::SeqCst), before + 1, "a 403 must lead to exactly one new login");
    let l = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": admin })).await;
    let vm1 = l["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-vm-1-cluster").unwrap().clone();
    assert_eq!(vm1["notes"], json!([]), "a fresh read, not the fallback: {vm1}");

    // --- Vault going away does not take the cluster offline
    vault_up.store(false, Ordering::SeqCst);
    let again = c.zabbix_sync().await;
    assert_eq!(again["ok"], json!(true));
    let l = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": admin })).await;
    let vm1 = l["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-vm-1-cluster").unwrap().clone();
    assert_eq!(vm1["credentialOk"], json!(true), "the last good password carries on: {vm1}");
    assert!(vm1["notes"].to_string().contains("last password"), "{vm1}");
    c.handle(json!({ "type": "ES", "session": admin, "clusterId": "zbx-vm-1-cluster", "method": "GET", "path": "/" })).await;
    assert_eq!(es.last_hit().unwrap().header("authorization"), Some(want.as_str()));
}
