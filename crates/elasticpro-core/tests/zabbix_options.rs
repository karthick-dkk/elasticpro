//! The config's `zabbix:` options, end to end: connecting Zabbix clusters with ElasticPro
//! Pro's credentials, and creating Zabbix hosts from the config.
//!
//! Its own binary: the Zabbix API, Vault and the config file are all configured from the
//! environment, which is process-wide.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::{TempDir, TestServer};

async fn admin(c: &Arc<Core>) -> String {
    let r = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(c) })).await;
    let s = r["session"].as_str().unwrap().to_string();
    c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": "correct-horse-battery" })).await;
    s
}

#[tokio::test]
async fn zabbix_options_from_the_config() {
    let es = TestServer::start().await;
    let (es_host, es_port) = {
        let u = es.url();
        let hp = u.trim_start_matches("http://").to_string();
        let (h, p) = hp.split_once(':').unwrap();
        (h.to_string(), p.to_string())
    };

    // Zabbix: one cluster host at the ES test server's address, whose password is a Secret
    // macro (unreadable) — so only ElasticPro's credential can connect it. Records writes.
    let calls: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let rec = calls.clone();
    let (h, p) = (es_host.clone(), es_port.clone());
    let zbx = TestServer::with(move |hit| {
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let tok = hit.header("authorization").unwrap_or("").to_string();
        let m = |k: &str, v: &str, t: &str| json!({ "macro": k, "value": v, "type": t });
        let method = b["method"].as_str().unwrap().to_string();
        rec.lock().unwrap().push(json!({ "method": method, "params": b["params"], "token": tok }));
        let result = match method.as_str() {
            "template.get" => json!([{ "templateid": match b["params"]["filter"]["host"][0].as_str() {
                Some("ElasticPro client plan") => "901", Some("ElasticPro alerts") => "902", _ => "900" },
                "host": b["params"]["filter"]["host"][0], "macros": [] }]),
            "usermacro.get" => json!([]),
            "host.get" if b["params"].get("templateids").is_some() => json!([
                { "hostid": "1", "host": "vm-1 cluster", "name": "vm-1 cluster", "hostgroups": [{ "groupid": "30" }],
                  "macros": [m("{$ELASTICSEARCH.HOST}", &h, "0"), m("{$ELASTICSEARCH.PORT}", &p, "0"),
                             m("{$ELASTICSEARCH.SCHEME}", "http", "0"), m("{$ELASTICSEARCH.PASSWORD}", "", "1")] },
            ]),
            "host.get" => json!([]),
            // A group somebody denied on purpose: a grant must leave that alone.
            "usergroup.get" if b["params"]["filter"]["name"][0] == "ES denied" =>
                json!([{ "usrgrpid": "8", "hostgroup_rights": [{ "id": "g-lab2", "permission": "0" }] }]),
            "usergroup.get" if b["params"].get("filter").is_some() => json!([{ "usrgrpid": "7", "hostgroup_rights": [] }]),
            "usergroup.get" => json!([]),
            "hostgroup.get" => json!([]),
            "hostgroup.create" => json!({ "groupids": [format!("g-{}", b["params"]["name"].as_str().unwrap())] }),
            "host.create" => json!({ "hostids": ["555"] }),
            "usergroup.update" => json!({ "usrgrpids": ["7"] }),
            other => panic!("unexpected Zabbix call {other}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await;

    // Vault: only the writer role may write.
    let stored: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
    let st = stored.clone();
    let vault = TestServer::with(move |hit| {
        if hit.path == "/v1/auth/approle/login" {
            let b: Value = serde_json::from_str(&hit.body).unwrap();
            let tok = if b["role_id"] == "writer" { "tok-w" } else { "tok-r" };
            return (200, format!(r#"{{"auth":{{"client_token":"{tok}","lease_duration":3600}}}}"#));
        }
        if hit.method == "POST" && hit.header("x-vault-token") == Some("tok-w") {
            st.lock().unwrap().push((hit.path.clone(), serde_json::from_str(&hit.body).unwrap()));
            return (200, "{}".into());
        }
        (403, r#"{"errors":["permission denied"]}"#.into())
    }).await;

    let dir = TempDir::new("zbx-options");
    let cfg = dir.join("config.json");
    let write_cfg = |z: Value| std::fs::write(&cfg, json!({ "clusters": [], "zabbix": z }).to_string()).unwrap();
    write_cfg(json!({ "useElasticProCredentials": true }));
    for (k, v) in [("zbx-read", "read-token"), ("zbx-write", "write-token"), ("r-role", "reader"), ("r-secret", "s"),
                   ("w-role", "writer"), ("w-secret", "s")] {
        std::fs::write(dir.join(k), v).unwrap();
    }
    std::env::set_var("ELASTICPRO_CONFIG", &cfg);
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-read"));
    std::env::set_var("ELASTICPRO_ZABBIX_API_WRITE_TOKEN_FILE", dir.join("zbx-write"));
    std::env::set_var("ELASTICPRO_VAULT_ADDR", vault.url());
    std::env::set_var("ELASTICPRO_VAULT_ROLE_ID_FILE", dir.join("r-role"));
    std::env::set_var("ELASTICPRO_VAULT_SECRET_ID_FILE", dir.join("r-secret"));
    std::env::set_var("ELASTICPRO_VAULT_WRITE_ROLE_ID_FILE", dir.join("w-role"));
    std::env::set_var("ELASTICPRO_VAULT_WRITE_SECRET_ID_FILE", dir.join("w-secret"));
    let data = TempDir::new("zbx-options-data");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    let s = admin(&c).await;

    // --- ElasticPro credentials: the one held for a config cluster at the same address
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [
        { "id": "vm-1", "name": "vm-1", "url": es.url(), "authHeader": "Basic ZmlsZTpmaWxl" }] })).await;
    let sync = c.zabbix_sync().await;
    assert_eq!(sync["credentials"], json!("elasticpro"), "{sync}");
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": s })).await;
    assert_eq!(list["useElasticProCredentials"], json!(true));
    assert_eq!(list["clusters"][0]["credential"], json!("elasticpro"));
    assert_eq!(list["clusters"][0]["credentialOk"], json!(true), "{list}");
    c.handle(json!({ "type": "ES", "session": s, "clusterId": "zbx-vm-1-cluster", "method": "GET", "path": "/" })).await;
    assert_eq!(es.last_hit().unwrap().header("authorization"), Some("Basic ZmlsZTpmaWxl"),
               "the Secret macro is unreadable; ElasticPro's credential must be what connects it");

    // --- ...else the config's shared credential
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [], "sharedAuthHeader": "Basic c2hhcmVkOnNoYXJlZA==" })).await;
    c.zabbix_sync().await;
    c.handle(json!({ "type": "ES", "session": s, "clusterId": "zbx-vm-1-cluster", "method": "GET", "path": "/" })).await;
    assert_eq!(es.last_hit().unwrap().header("authorization"), Some("Basic c2hhcmVkOnNoYXJlZA=="));

    // --- cleared on purpose, it is gone — not carried on as "the last password that worked"
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [], "sharedAuthHeader": "" })).await;
    c.zabbix_sync().await;
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": s })).await;
    assert_eq!(list["clusters"][0]["credentialOk"], json!(false), "a removed credential must stay removed: {list}");

    // --- switched off, it goes back to Zabbix's own (a Secret macro here: unusable, and said)
    write_cfg(json!({ "useElasticProCredentials": false }));
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [], "sharedAuthHeader": "" })).await;
    c.zabbix_sync().await;
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": s })).await;
    assert_eq!(list["clusters"][0]["credential"], json!("secret-macro"), "{list}");

    // --- createHosts: a config cluster Zabbix does not have becomes a host
    write_cfg(json!({ "createHosts": true }));
    calls.lock().unwrap().clear();
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [
        { "id": "lab", "name": "lab", "url": "http://10.1.2.3:9201", "authHeader": "Basic bGFidXNlcjpsYWJwYXNz",
          "zabbixGroups": ["ES lab"] },
        { "id": "lab2", "name": "lab2", "url": "http://10.1.2.4:9201", "authHeader": "Basic bGFidXNlcjpsYWJwYXNz",
          "zabbixGroups": ["ES denied"] }] })).await;
    let sync = c.zabbix_sync().await;
    assert!(sync["provisioned"].to_string().contains("created"), "{sync}");
    let recorded = calls.lock().unwrap().clone();
    let create = recorded.iter().find(|x| x["method"] == "host.create" && x["params"]["host"] == "lab").expect("a host.create for lab").clone();
    assert_eq!(create["token"], json!("Bearer write-token"), "creating uses the write token, never the sync's");
    assert!(recorded.iter().filter(|x| x["method"] != "host.create" && x["method"] != "hostgroup.create"
                                  && x["method"] != "usergroup.update" && x["method"] != "hostgroup.get"
                                  && !(x["method"] == "template.get" && x["token"] == "Bearer write-token")
                                  && !(x["method"] == "host.get" && x["token"] == "Bearer write-token")
                                  && !(x["method"] == "usergroup.get" && x["token"] == "Bearer write-token"))
                    .all(|x| x["token"] == "Bearer read-token"), "the sync itself only ever reads");
    let macros = create["params"]["macros"].to_string();
    assert!(macros.contains("\"10.1.2.3\"") && macros.contains("\"9201\"") && macros.contains("\"labuser\""), "{macros}");
    assert!(macros.contains("secret/elasticpro/lab:password"), "the password macro is a Vault reference: {macros}");
    assert!(!create.to_string().contains("labpass"), "the password itself must never reach Zabbix");
    assert_eq!(create["params"]["templates"], json!([{ "templateid": "900" }, { "templateid": "901" }, { "templateid": "902" }]),
               "the cluster template, and ElasticPro's plan and alerts templates when Zabbix has them");
    let vaulted = stored.lock().unwrap().clone();
    assert_eq!(vaulted.len(), 2);
    let vaulted: Vec<_> = vaulted.into_iter().filter(|(p, _)| p.ends_with("/lab")).collect();
    assert_eq!(vaulted[0].0, "/v1/secret/data/elasticpro/lab");
    assert_eq!(vaulted[0].1["data"], json!({ "username": "labuser", "password": "labpass" }));
    let grants: Vec<&Value> = recorded.iter().filter(|x| x["method"] == "usergroup.update").collect();
    assert_eq!(grants.len(), 1, "the denied group must not be touched: {grants:?}");
    assert_eq!(grants[0]["params"]["hostgroup_rights"], json!([{ "id": "g-lab", "permission": 2 }]));

    // --- off again: nothing more is created
    write_cfg(json!({ "createHosts": false }));
    calls.lock().unwrap().clear();
    c.zabbix_sync().await;
    assert!(!calls.lock().unwrap().iter().any(|x| x["method"] == "host.create"), "createHosts off must create nothing");
}
