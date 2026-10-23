//! Passwords Zabbix keeps as Secret macros, handed over by the Zabbix module.
//!
//! Zabbix never returns a Secret macro's value through its API, so a cluster whose password is
//! kept that way used to be synced with no usable credential — and, before polling learned to
//! skip it, hit with a failed sign-in on every interval. The Zabbix module now hands the password
//! over (`POST /sso/zabbix/cluster-secret`, signed). This proves, end to end against a fake
//! Zabbix:
//!   * a cluster whose own password the core holds is polled, with it;
//!   * a cluster with no password of its own uses the default (`cluster: "*"`) when held;
//!   * a cluster whose secret the core does not hold is "password not set" and NOT polled;
//!   * the hand-over is refused unsigned, and its answer is signed and never carries the password.
//!
//! One test function: the Zabbix API is configured from the environment, which is process-wide.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::{reply_material, ZabbixSso};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{TempDir, TestServer};

const SECRET: &str = "integration-secret-0123456789abcdef-xyz";

async fn zsession(c: &Arc<Core>, user: &str, ty: i64) -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let body = serde_json::to_vec(&json!({ "username": user, "zabbix_user_type": ty, "groups": [],
        "ts": ts.as_secs(), "nonce": format!("nonce-{}-{user}", ts.as_nanos()) })).unwrap();
    let (_, out) = c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body));
    c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await["session"].as_str().unwrap().to_string()
}

/// The module's half: sign a hand-over and post it.
fn hand_over(c: &Arc<Core>, cluster: &str, password: &str, tag: &str) -> (u16, Value, Option<String>, Vec<u8>, u64, String) {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let nonce = format!("n-{}-{tag}", ts.as_nanos());
    let body = serde_json::to_vec(&json!({ "cluster": cluster, "user": "svc-es", "password": password, "set_by": "alice",
        "ts": ts.as_secs(), "nonce": nonce })).unwrap();
    let r = c.zabbix_cluster_secret_from(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body), None);
    let v: Value = serde_json::from_slice(&r.body).unwrap();
    (r.status, v, r.signature, r.body, ts.as_secs(), nonce)
}

#[tokio::test]
async fn secret_macros_are_polled_only_with_a_password_the_core_was_handed() {
    let zbx = TestServer::with(move |hit| {
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let p = &b["params"];
        let m = |k: &str, v: &str, t: &str| json!({ "macro": k, "value": v, "type": t });
        // A Secret macro comes back with no value, as Zabbix answers it.
        let secret = |k: &str| json!({ "macro": k, "type": "1" });
        let result = match b["method"].as_str().unwrap() {
            "template.get" => json!([{ "templateid": "900", "host": "Elasticsearch Cluster by HTTP EP", "macros": [] }]),
            // The default credential: global macros, the password a Secret.
            "usermacro.get" if p["globalmacro"] == json!(true) => json!([m("{$ELASTICSEARCH.USERNAME}", "svc-es", "0"), secret("{$ELASTICSEARCH.PASSWORD}")]),
            "usermacro.get" => json!([]),
            "host.get" if p["templateids"] == json!(["900"]) => json!([
                // Its own password, handed over below.
                { "hostid": "1", "host": "own-held", "name": "own-held", "hostgroups": [],
                  "macros": [m("{$ELASTICSEARCH.HOST}", "10.0.0.1", "0"), m("{$ELASTICSEARCH.SCHEME}", "http", "0"), secret("{$ELASTICSEARCH.PASSWORD}")] },
                // Its own password, never handed over.
                { "hostid": "2", "host": "own-unheld", "name": "own-unheld", "hostgroups": [],
                  "macros": [m("{$ELASTICSEARCH.HOST}", "10.0.0.2", "0"), m("{$ELASTICSEARCH.SCHEME}", "http", "0"), secret("{$ELASTICSEARCH.PASSWORD}")] },
                // No password of its own: the default.
                { "hostid": "3", "host": "on-default", "name": "on-default", "hostgroups": [],
                  "macros": [m("{$ELASTICSEARCH.HOST}", "10.0.0.3", "0"), m("{$ELASTICSEARCH.SCHEME}", "http", "0")] },
            ]),
            "host.get" => json!([]),
            "usergroup.get" => json!([]),
            other => panic!("unexpected Zabbix call {other} {p}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await;

    let dir = TempDir::new("zbx-secret");
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    std::env::set_var("ELASTICPRO_CLUSTER_SECRET_KEY", "k".repeat(48));
    let data = TempDir::new("zbx-secret-data");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();

    // --- before anything is handed over: none of the three is usable, none is polled.
    let sync = c.zabbix_sync().await;
    assert_eq!(sync["ok"], json!(true), "{sync}");
    assert_eq!(sync["clusters"], json!(3), "{sync}");
    assert_eq!(sync["inUse"], json!(0), "a Secret macro the core was not given is never polled: {sync}");

    // --- the hand-over: unsigned refused; signed kept, answered signed, password nowhere in it.
    let body = br#"{"cluster":"own-held","user":"x","password":"nope","set_by":"m","ts":1,"nonce":"n-0123456789abcdef"}"#;
    let r = c.zabbix_cluster_secret_from(body, "00", None);
    assert_eq!(r.status, 401);
    assert!(r.signature.is_none());
    let (st, v, sig, raw, ts, nonce) = hand_over(&c, "own-held", "own-pw-1", "a");
    assert_eq!(st, 200, "{v}");
    assert_eq!((v["ok"].clone(), v["cluster"].clone()), (json!(true), json!("own-held")));
    assert_eq!(sig.as_deref(), Some(ZabbixSso::sign(SECRET.as_bytes(), &reply_material(ts, &nonce, &raw)).as_str()), "the answer is signed over the request's ts and nonce");
    assert!(!String::from_utf8_lossy(&raw).contains("own-pw-1"));
    let (st, _, _, _, _, _) = hand_over(&c, "*", "default-pw", "b");
    assert_eq!(st, 200);
    let kept = std::fs::read_to_string(data.join("cluster-secrets.json")).unwrap();
    assert!(!kept.contains("own-pw-1") && !kept.contains("default-pw"), "encrypted at rest");

    // --- after: the held one and the default one are polled; the unheld one is not.
    let sync = c.zabbix_sync().await;
    assert_eq!(sync["inUse"], json!(2), "{sync}");
    let admin = zsession(&c, "sara", 3).await;
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": admin })).await;
    let by: std::collections::HashMap<String, Value> = list["clusters"].as_array().unwrap().iter()
        .map(|v| (v["zabbixHost"].as_str().unwrap().to_string(), v.clone())).collect();
    assert_eq!(by["own-held"]["credential"], json!("core-secret"), "{list}");
    assert_eq!(by["own-held"]["credentialOk"], json!(true));
    assert_eq!(by["on-default"]["credential"], json!("core-default"), "{list}");
    assert_eq!(by["on-default"]["credentialOk"], json!(true));
    assert_eq!(by["own-unheld"]["credential"], json!("password-not-set"), "{list}");
    assert_eq!(by["own-unheld"]["credentialOk"], json!(false));
    assert!(by["own-unheld"]["notes"].to_string().contains("password not set"), "{list}");
    assert!(!list.to_string().contains("own-pw-1") && !list.to_string().contains("default-pw"), "never in a listing");

    // --- an override the core never got is not quietly replaced by the default.
    assert_eq!(by["own-unheld"]["credentialOk"], json!(false), "the default must not stand in for a cluster's own password");
}
