//! `CLUSTER_SAVE` and the Zabbix role map, end to end: an operator adds, changes and
//! switches off a cluster in the server's config file and the fleet follows; the file's
//! `zabbix.roleMap` decides what a Zabbix sign-in becomes.
//!
//! Its own test binary because it needs `ELASTICPRO_CONFIG`, which is process-wide, and
//! every other test builds cores that must not see it.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{TempDir, TestServer};

const SECRET: &str = "cluster-save-secret-0123456789abcdef-xyz";
const SHARED: &str = "Basic ZmxlZXQ6ZmxlZXQtcHc=";

/// ELASTICPRO_CONFIG is one per process and each test sets its own: they take turns.
static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn signed(c: &Arc<Core>, body: Value) -> (u16, Value) {
    let body = serde_json::to_vec(&body).unwrap();
    c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body))
}

/// Zabbix's half and the browser's: a session for a Zabbix user of this type, with this role name.
async fn zabbix_session(c: &Arc<Core>, user: &str, ty: i64, role: Option<&str>) -> (u16, Value, Option<String>) {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let mut claim = json!({ "username": user, "zabbix_user_type": ty, "groups": [], "ts": ts.as_secs(), "nonce": format!("nonce-{}", ts.as_nanos()) });
    if let Some(r) = role {
        claim["zabbix_role"] = json!(r);
        claim["zabbix_roleid"] = json!(7);
    }
    let (status, out) = signed(c, claim);
    if status != 200 {
        return (status, out, None);
    }
    let res = c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await;
    (status, out, Some(res["session"].as_str().expect("a session").to_string()))
}

async fn operator(c: &Arc<Core>) -> String {
    zabbix_session(c, "adam", 2, None).await.2.expect("an operator session")
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": "correct-horse-battery" })).await;
    assert_eq!(ch["ok"], json!(true));
    s
}

fn config(alpha_url: &str) -> Value {
    json!({
        "version": 2,
        "credentials": { "username": "fleet", "password": "fleet-pw" },
        "defaults": { "logIndexPattern": "logs-*" },
        "jump_hosts": { "jumpa": { "host": "jump-a.example", "user": "ops", "keyFile": "/keys/a" } },
        "clusters": [
            { "name": "Alpha", "url": alpha_url, "apiKey": "alpha-api-key", "tags": ["prod"] }
        ]
    })
}

fn hosted(dir: &TempDir, cfg: &Value) -> (Arc<Core>, std::path::PathBuf) {
    let path = dir.join("config_cluster.json");
    std::fs::write(&path, serde_json::to_string_pretty(cfg).unwrap()).unwrap();
    std::env::set_var("ELASTICPRO_CONFIG", &path);
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();
    (c, path)
}

fn file(path: &std::path::Path) -> (String, Value) {
    let text = std::fs::read_to_string(path).unwrap();
    let v = serde_json::from_str(&text).unwrap();
    (text, v)
}

async fn save(c: &Arc<Core>, s: &str, cluster: Value, replace: Option<&str>) -> Value {
    c.handle(json!({ "type": "CLUSTER_SAVE", "session": s, "cluster": cluster, "replace": replace })).await
}

async fn health(c: &Arc<Core>, s: &str, id: &str) -> Value {
    c.handle(json!({ "type": "ES", "session": s, "clusterId": id, "method": "GET", "path": "/_cluster/health" })).await
}

#[tokio::test]
async fn an_operator_adds_changes_and_switches_off_a_cluster_and_the_fleet_follows() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("cluster-save");
    let alpha = TestServer::start().await;
    let gamma = TestServer::start().await;
    let (c, path) = hosted(&dir, &config(&alpha.url()));

    // An admin primed the core once: Alpha with its own header, and the shared credential.
    let a = admin(&c).await;
    let r = c.handle(json!({ "type": "PRIME", "session": a, "readOnly": true, "sharedAuthHeader": SHARED,
        "clusters": [{ "id": "alpha", "name": "Alpha", "url": alpha.url(), "authHeader": "Basic YWxwaGE6a2V5" }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let op = operator(&c).await;

    // Add. What CONFIG_VIEW shows carries _index; the operator sends that shape back.
    let r = save(&c, &op, json!({ "name": "Gamma", "url": format!("{}/", gamma.url()), "note": "new", "_index": 9 }), None).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!((r["action"].clone(), r["name"].clone(), r["credential"].clone()), (json!("added"), json!("Gamma"), json!("shared")));
    assert!(r.get("path").is_none(), "the server's paths are not the operator's business: {r}");
    let (text, v) = file(&path);
    assert!(text.starts_with("{\n  \"version\": 2,\n  \"credentials\""), "written in the UI's key order:\n{text}");
    assert_eq!(v["clusters"].as_array().unwrap().len(), 2);
    assert_eq!(v["clusters"][1], json!({ "name": "Gamma", "url": gamma.url(), "note": "new" }));
    assert_eq!(v["clusters"][0]["apiKey"], json!("alpha-api-key"), "Alpha's own credential is untouched");
    assert_eq!(v["credentials"]["password"], json!("fleet-pw"));

    // The fleet polls it now, with the shared credential — no admin PRIME in between.
    let r = health(&c, &op, "gamma").await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let hit = gamma.last_hit().expect("the request reached the new cluster");
    assert_eq!(hit.header("authorization"), Some(SHARED));
    let r = c.handle(json!({ "type": "CONFIG_VIEW", "session": op })).await;
    assert_eq!(r["clusters"], json!(2));
    assert!(!r["text"].as_str().unwrap().contains("alpha-api-key"));
    // And it survives a restart: the core wrote what it holds.
    let primed = std::fs::read_to_string(dir.join("primed.json")).unwrap();
    assert!(primed.contains("\"gamma\"") && primed.contains(SHARED), "{primed}");

    // A credential in the save is refused, not dropped; nothing changes.
    for bad in [json!({ "name": "Delta", "url": "https://delta:9200", "password": "p" }),
                json!({ "name": "Delta", "url": "https://u:p@delta:9200" })] {
        let r = save(&c, &op, bad, None).await;
        assert_eq!(r["kind"], json!("credential_refused"), "{r}");
    }
    let r = save(&c, &op, json!({ "name": "Delta", "url": "https://delta:9200", "via": "nowhere" }), None).await;
    assert_eq!(r["kind"], json!("bad_message"), "{r}");
    assert_eq!(file(&path).1["clusters"].as_array().unwrap().len(), 2);

    // A user may not; a guest may not.
    let (_, _, user) = zabbix_session(&c, "uma", 1, None).await;
    let r = save(&c, &user.unwrap(), json!({ "name": "Delta", "url": "https://delta:9200" }), None).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");
    assert_eq!(file(&path).1["clusters"].as_array().unwrap().len(), 2);

    // Edit: a rename at the same address keeps the credential the core holds.
    let r = save(&c, &op, json!({ "name": "Gamma Two", "url": gamma.url(), "note": "renamed" }), Some("Gamma")).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!((r["action"].clone(), r["was"].clone(), r["credential"].clone()), (json!("edited"), json!("Gamma"), json!("kept")));
    assert_eq!(health(&c, &op, "gamma-two").await["ok"], json!(true));
    assert_eq!(gamma.last_hit().unwrap().header("authorization"), Some(SHARED));
    assert_eq!(health(&c, &op, "gamma").await["ok"], json!(false), "the old id is gone");
    let v = file(&path).1;
    assert_eq!(v["clusters"][1]["name"], json!("Gamma Two"));
    assert_eq!(v["clusters"].as_array().unwrap().len(), 2, "an edit never removes");

    // Alpha signs in with a credential of its own: an operator may not move it — the next
    // admin PRIME would build a header from the file and send it wherever the entry points.
    let r = save(&c, &op, json!({ "name": "Alpha", "url": "https://alpha-moved.example:9200", "tags": ["prod"] }), Some("Alpha")).await;
    assert_eq!(r["kind"], json!("credential_refused"), "{r}");
    let v = file(&path).1;
    assert_eq!(v["clusters"][0]["url"], json!(alpha.url()));
    // Everything else about it, yes — and the header the core holds for it stays.
    let r = save(&c, &op, json!({ "name": "Alpha", "url": alpha.url(), "tags": ["prod", "eu"] }), Some("Alpha")).await;
    assert_eq!((r["ok"].clone(), r["credential"].clone()), (json!(true), json!("kept")), "{r}");
    assert_eq!(health(&c, &op, "alpha").await["ok"], json!(true));
    assert_eq!(alpha.last_hit().unwrap().header("authorization"), Some("Basic YWxwaGE6a2V5"));
    assert_eq!(file(&path).1["clusters"][0]["apiKey"], json!("alpha-api-key"), "the credential stays with the entry");
    // A name that is Alpha's id in another spelling would take over its polled entry: refused.
    let r = save(&c, &op, json!({ "name": "alpha", "url": gamma.url() }), None).await;
    assert_eq!(r["kind"], json!("name_taken"), "{r}");
    assert_eq!(health(&c, &op, "alpha").await["ok"], json!(true));
    assert_eq!(alpha.last_hit().unwrap().header("authorization"), Some("Basic YWxwaGE6a2V5"), "Alpha is still Alpha");

    // Switch Gamma Two off: in the file, not polled from the page.
    let r = save(&c, &op, json!({ "name": "Gamma Two", "url": gamma.url(), "enabled": false }), Some("Gamma Two")).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(file(&path).1["clusters"][1]["enabled"], json!(false));

    // Automations: the list is the operator's to write, the rest of the file is not.
    let r = c.handle(json!({ "type": "AUTOMATIONS_SAVE", "session": op, "automations": [{ "id": "r1", "name": "old logs", "action": "delete" }] })).await;
    assert_eq!((r["ok"].clone(), r["count"].clone()), (json!(true), json!(1)), "{r}");
    let v = file(&path).1;
    assert_eq!(v["automations"][0]["id"], json!("r1"));
    assert_eq!(v["clusters"].as_array().unwrap().len(), 2);
    let r = c.handle(json!({ "type": "AUTOMATIONS_SAVE", "session": op, "automations": [{ "id": "r2", "apiKey": "k" }] })).await;
    assert_eq!(r["kind"], json!("credential_refused"), "{r}");
    assert_eq!(file(&path).1["automations"].as_array().unwrap().len(), 1);

    // Remove: there is no such message for an operator — and CONFIG_WRITE is refused.
    let r = c.handle(json!({ "type": "CONFIG_WRITE", "session": op, "path": path.to_string_lossy(), "text": "{}" })).await;
    assert_eq!(r["kind"], json!("forbidden"));
    assert_eq!(file(&path).1["clusters"].as_array().unwrap().len(), 2);

    // The version before a save is kept, for an admin to go back to. (History keeps one
    // slot per second, as it does for an admin's saves, so these saves — all within one
    // second here — leave the state before the last of them.)
    let r = c.handle(json!({ "type": "CONFIG_HISTORY", "session": a })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let versions = r["versions"].as_array().cloned().unwrap_or_default();
    assert!(!versions.is_empty(), "{r}");
    let last = versions.last().unwrap();
    let kept = c.handle(json!({ "type": "CONFIG_RESTORE", "session": a, "id": last["id"] })).await;
    let kept = kept["text"].as_str().unwrap_or("");
    assert!(kept.contains("alpha-api-key") && kept.contains("Gamma Two") && !kept.contains("\"r1\""),
            "the kept version is the file before the last save (the automations): {kept}");
}

#[tokio::test]
async fn the_role_map_in_the_config_decides_what_a_zabbix_sign_in_becomes() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("role-map");
    let mut cfg = config("https://alpha.example:9200");
    cfg["zabbix"] = json!({ "roleMap": { "names": { "ES owners": "admin", "Nobody": "none" }, "types": { "2": "user" } } });
    let (c, path) = hosted(&dir, &cfg);

    // Type 2 without a role name: the map's type entry (user, not the shipped operator).
    let (_, out, _) = zabbix_session(&c, "adam", 2, None).await;
    assert_eq!(out["role"], json!("user"), "{out}");
    // A Zabbix User holding the "ES owners" role: an admin, by name.
    let (_, out, _) = zabbix_session(&c, "olga", 1, Some("ES owners")).await;
    assert_eq!(out["role"], json!("admin"), "{out}");
    // A Super admin whose role is mapped to none is not signed in at all.
    let (status, out, s) = zabbix_session(&c, "nemo", 3, Some("Nobody")).await;
    assert_eq!((status, out["kind"].clone(), s), (403, json!("no_role"), None), "{out}");
    assert!(out["message"].as_str().unwrap().contains("\"Nobody\""), "{out}");
    // A role name the map does not know: the type decides.
    let (_, out, _) = zabbix_session(&c, "sara", 3, Some("Super admin role")).await;
    assert_eq!(out["role"], json!("admin"), "{out}");

    // The role lookup answers with the mapped role for a person it has never seen.
    let ts = now();
    let claim = serde_json::to_vec(&json!({ "zabbix_user": "new-person", "zabbix_user_type": 2, "zabbix_role": "ES owners", "ts": ts, "nonce": format!("nonce-lookup-{ts}") })).unwrap();
    let reply = c.zabbix_sso_role_from(&claim, &ZabbixSso::sign(SECRET.as_bytes(), &claim), None);
    let body: Value = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!((reply.status, body["role"].clone(), body["zabbix_role"].clone()), (200, Value::Null, json!("admin")), "{body}");

    // Reading and changing the map is an admin's.
    let a = admin(&c).await;
    let r = c.handle(json!({ "type": "ZABBIX_ROLEMAP_GET", "session": a })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["roleMap"]["names"]["ES owners"], json!("admin"));
    assert_eq!(r["roleMap"]["types"], json!({ "1": "user", "2": "user", "3": "admin" }));
    assert_eq!(r["defaults"]["types"]["2"], json!("operator"));
    assert_eq!(r["file"], json!(true));
    assert!(r["zabbixRoles"].is_null() && r["zabbixError"].is_string(), "no Zabbix is paired here: {r}");
    let op = zabbix_session(&c, "olga", 1, Some("ES owners")).await.2.unwrap();
    let (_, _, viewer) = zabbix_session(&c, "adam", 2, None).await;
    let r = c.handle(json!({ "type": "ZABBIX_ROLEMAP_GET", "session": viewer.unwrap() })).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");

    let r = c.handle(json!({ "type": "ZABBIX_ROLEMAP_SET", "session": op, "roleMap": { "names": { "A": "emperor" } } })).await;
    assert_eq!(r["kind"], json!("bad_message"), "{r}");
    let r = c.handle(json!({ "type": "ZABBIX_ROLEMAP_SET", "session": op, "roleMap": { "names": { "ES owners": "operator" }, "types": { "2": "operator" } } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let v = file(&path).1;
    assert_eq!(v["zabbix"]["roleMap"], json!({ "names": { "ES owners": "operator" }, "types": { "1": "user", "2": "operator", "3": "admin" } }));
    assert_eq!(v["clusters"][0]["apiKey"], json!("alpha-api-key"), "the rest of the file is as it was");

    // The next sign-in follows the new map; an account an admin pinned does not.
    let (_, out, _) = zabbix_session(&c, "adam", 2, None).await;
    assert_eq!(out["role"], json!("operator"), "{out}");
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "olga@zabbix", "role": "admin" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let (_, out, _) = zabbix_session(&c, "olga", 1, Some("ES owners")).await;
    assert_eq!(out["role"], json!("admin"), "pinned: {out}");
}
