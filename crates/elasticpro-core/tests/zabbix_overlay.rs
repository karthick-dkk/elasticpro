//! Zabbix clusters edited in ElasticPro (zbx_overlay.rs), end to end against a fake Zabbix:
//!   * ZABBIX_CLUSTER_SAVE is an operator's, on a cluster they see; a user is refused;
//!   * the address, a credential and an unknown jump host are refused, each with its kind;
//!   * an edit applies at once, survives every sync, and wins when Zabbix changes the same field;
//!     "Use Zabbix's value" (reset) takes back just that field;
//!   * an admin's CREDENTIAL_SET for a Zabbix cluster is kept bound to the address Zabbix gives —
//!     the cluster is polled with it, and not when Zabbix moves the cluster;
//!   * an operator may not move a cluster that signs in with a credential of its own;
//!   * switched off: listed, not polled; a host that disappears keeps its overlay (orphan), which
//!     applies again when it returns, and after a restart;
//!   * Zabbix is only ever read (no write method is called).
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

async fn zsession(c: &Arc<Core>, user: &str, ty: i64) -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let body = serde_json::to_vec(&json!({ "username": user, "zabbix_user_type": ty, "groups": [],
        "ts": ts.as_secs(), "nonce": format!("nonce-{}-{user}", ts.as_nanos()) })).unwrap();
    let (_, out) = c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body));
    c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await["session"].as_str().unwrap().to_string()
}

/// The fake Zabbix's hosts: (hostid, technical name, visible name, ES host macro, password:
/// "secret" a Secret macro, "plain" a password macro, "none" no password at all).
type Hosts = Arc<Mutex<Vec<(String, String, String, String, &'static str)>>>;

fn host_json(h: &(String, String, String, String, &'static str)) -> Value {
    let m = |k: &str, v: &str| json!({ "macro": k, "value": v, "type": "0" });
    let mut macros = vec![m("{$ELASTICSEARCH.HOST}", &h.3), m("{$ELASTICSEARCH.SCHEME}", "http"), m("{$ELASTICSEARCH.USERNAME}", "svc")];
    match h.4 {
        "secret" => macros.push(json!({ "macro": "{$ELASTICSEARCH.PASSWORD}", "type": "1" })),
        "plain" => macros.push(m("{$ELASTICSEARCH.PASSWORD}", "pw")),
        _ => {}
    }
    json!({ "hostid": h.0, "host": h.1, "name": h.2, "hostgroups": [], "tags": [], "macros": macros })
}

async fn row(c: &Arc<Core>, s: &str, host_id: &str) -> Value {
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": s })).await;
    list["clusters"].as_array().unwrap().iter().find(|v| v["zabbixHostId"] == host_id).cloned().unwrap_or(Value::Null)
}

async fn save(c: &Arc<Core>, s: &str, host_id: &str, set: Value, reset: Value) -> Value {
    c.handle(json!({ "type": "ZABBIX_CLUSTER_SAVE", "session": s, "hostId": host_id, "set": set, "reset": reset })).await
}

#[tokio::test]
async fn zabbix_clusters_are_edited_in_elasticpro_and_the_edit_survives_every_sync() {
    let hosts: Hosts = Arc::new(Mutex::new(vec![
        ("101".into(), "es-prod".into(), "es-prod".into(), "10.0.0.1".into(), "secret"),
        ("102".into(), "es-dev".into(), "es-dev".into(), "10.0.0.2".into(), "plain"),
        ("103".into(), "es-open".into(), "es-open".into(), "10.0.0.3".into(), "none"),
    ]));
    let methods = Arc::new(Mutex::new(Vec::<String>::new()));
    let (hs, ms) = (hosts.clone(), methods.clone());
    let zbx = TestServer::with(move |hit| {
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let p = &b["params"];
        let method = b["method"].as_str().unwrap().to_string();
        ms.lock().unwrap().push(method.clone());
        let result = match method.as_str() {
            "template.get" => json!([{ "templateid": "900", "host": "Elasticsearch Cluster by HTTP EP", "macros": [] }]),
            "usermacro.get" => json!([]),
            "host.get" if p["templateids"] == json!(["900"]) => json!(hs.lock().unwrap().iter().map(host_json).collect::<Vec<_>>()),
            "host.get" => json!([]),
            "usergroup.get" | "user.get" => json!([]),
            other => panic!("unexpected Zabbix call {other} {p}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await;

    let dir = TempDir::new("zbx-overlay");
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    std::env::set_var("ELASTICPRO_CLUSTER_SECRET_KEY", "k".repeat(48));
    let data = TempDir::new("zbx-overlay-data");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();

    let sync = c.zabbix_sync().await;
    assert_eq!((sync["clusters"].clone(), sync["inUse"].clone()), (json!(3), json!(2)), "es-prod's Secret macro was never handed over: {sync}");
    let admin = zsession(&c, "sara", 3).await;
    let oper = zsession(&c, "otto", 2).await;
    let user = zsession(&c, "uma", 1).await;

    // --- who: an operator's, like CLUSTER_SAVE; a user is refused, and nothing is written.
    let r = save(&c, &user, "102", json!({ "name": "Dev EU" }), json!([])).await;
    assert_eq!(r["ok"], json!(false), "{r}");
    assert!(!data.join("zabbix-overrides.json").exists());

    // --- what: never the address, never a credential, only a jump host ElasticPro has.
    for (set, kind) in [(json!({ "url": "http://10.9.9.9:9200" }), "url_from_zabbix"), (json!({ "password": "x" }), "credential"),
                        (json!({ "via": "nope" }), "unknown_jump"), (json!({ "volumeWindowDays": 0 }), "bad_request"),
                        (json!({ "logTimeZone": "Mars/Olympus" }), "bad_request"), (json!({ "name": "es-prod" }), "name_taken")] {
        let r = save(&c, &oper, "102", set.clone(), json!([])).await;
        assert_eq!(r["kind"], json!(kind), "{set}: {r}");
    }
    let r = save(&c, &oper, "999", json!({ "name": "x" }), json!([])).await;
    assert_eq!(r["kind"], json!("not_found"), "{r}");

    // --- an edit applies at once, without asking Zabbix.
    let calls = methods.lock().unwrap().len();
    let r = save(&c, &oper, "102", json!({ "name": "Dev EU", "tags": ["eu", "dev"], "note": "team A", "liveRetention": "30d", "logTimeZone": "europe/berlin" }), json!([])).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    // es-dev signs in with its own password macro: where it is sent is an admin's to change.
    for set in [json!({ "tls": "system" }), json!({ "via": "" })] {
        let r = save(&c, &oper, "102", set.clone(), json!([])).await;
        assert_eq!(r["kind"], json!("credential_destination"), "{set}: {r}");
    }
    // Certificates off: never below admin, not even on a cluster with no credential at all.
    let r = save(&c, &oper, "103", json!({ "tls": "insecure" }), json!([])).await;
    assert_eq!(r["kind"], json!("tls_insecure"), "{r}");
    // A cluster with no credential of its own: the operator may route it.
    let r = save(&c, &oper, "103", json!({ "tls": "system", "via": "" }), json!([])).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = save(&c, &admin, "102", json!({ "tls": "system" }), json!([])).await;
    assert_eq!(r["ok"], json!(true), "an admin may: {r}");
    assert_eq!(methods.lock().unwrap().len(), calls, "applied from the last sync's reading");
    let d = row(&c, &oper, "102").await;
    assert_eq!((d["name"].clone(), d["tags"].clone(), d["note"].clone(), d["liveRetention"].clone(), d["tls"].clone()),
               (json!("Dev EU"), json!(["eu", "dev"]), json!("team A"), json!("30d"), json!("system")), "{d}");
    assert_eq!(d["url"], json!("http://10.0.0.2:9200"), "the address is Zabbix's");
    assert_eq!(d["zabbixValues"]["name"], json!("es-dev"), "{d}");
    assert_eq!(d["logTimeZone"], json!("Europe/Berlin"), "kept canonical: {d}");
    assert_eq!(d["overridden"], json!(["liveRetention", "logTimeZone", "name", "note", "tags", "tls"]), "{d}");
    // The log delay measurement reads it from the cluster the sync built (logdelay::tz).
    let g = c.handle(json!({ "type": "LOGDELAY_SETTINGS_GET", "session": &admin })).await;
    let dev = g["resolved"].as_array().unwrap().iter().find(|x| x["id"] == d["_id"]).cloned().unwrap_or(Value::Null);
    assert_eq!(dev["logTimeZone"], json!("Europe/Berlin"), "{g}");
    assert_eq!(dev["timeZone"]["mode"], json!("set"), "{g}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(data.join("zabbix-overrides.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // --- Zabbix renames the host: the overlay's name still wins; a reset gives Zabbix's back.
    hosts.lock().unwrap()[1].2 = "es-dev-2".into();
    c.zabbix_sync().await;
    assert_eq!(row(&c, &oper, "102").await["name"], json!("Dev EU"), "the overlay wins over Zabbix's change");
    let r = save(&c, &oper, "102", json!({}), json!(["name"])).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let d = row(&c, &oper, "102").await;
    assert_eq!((d["name"].clone(), d["note"].clone()), (json!("es-dev-2"), json!("team A")), "only the name went back: {d}");

    // --- an admin types es-prod's own credential: kept bound to the address, polled with it.
    // es-prod (a Secret macro nobody handed over, so no credential yet): the operator may route it.
    let r = save(&c, &oper, "101", json!({ "tls": "system" }), json!([])).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    save(&c, &oper, "101", json!({}), json!(["tls"])).await;
    let r = c.handle(json!({ "type": "CREDENTIAL_SET", "session": oper, "cluster": "zbx-es-prod", "username": "svc", "password": "own-pw" })).await;
    assert_eq!(r["ok"], json!(false), "a credential is an admin's: {r}");
    let r = c.handle(json!({ "type": "CREDENTIAL_SET", "session": admin, "cluster": "zbx-es-prod", "username": "svc-own", "password": "own-pw" })).await;
    assert_eq!(r["ok"], json!(true), "a Zabbix cluster that is not polled has a destination too: {r}");
    let p = row(&c, &admin, "101").await;
    assert_eq!((p["credential"].clone(), p["credentialOk"].clone(), p["ownCredential"].clone(), p["username"].clone()),
               (json!("elasticpro-own"), json!(true), json!(true), json!("svc-own")), "{p}");
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": admin })).await;
    assert!(!list.to_string().contains("own-pw"), "never in a listing");
    assert!(!std::fs::read_to_string(data.join("cluster-secrets.json")).unwrap().contains("own-pw"), "encrypted at rest");
    let st = c.handle(json!({ "type": "CREDENTIAL_STATUS", "session": admin })).await;
    assert!(st["clusters"].as_array().unwrap().iter().any(|e| e["id"] == "zbx-es-prod" && e["moved"] == false), "{st}");

    // --- an operator may not move a cluster that signs in with its own credential; an admin may.
    let r = save(&c, &oper, "101", json!({ "via": "" }), json!([])).await;
    assert_eq!(r["kind"], json!("credential_destination"), "{r}");
    let r = save(&c, &oper, "101", json!({ "note": "ok to change" }), json!([])).await;
    assert_eq!(r["ok"], json!(true), "everything else stays the operator's: {r}");

    // --- Zabbix moves es-prod: the credential stays with the old address and is not sent.
    hosts.lock().unwrap()[0].3 = "10.0.0.9".into();
    c.zabbix_sync().await;
    let p = row(&c, &admin, "101").await;
    assert_eq!((p["credential"].clone(), p["credentialOk"].clone(), p["ownCredentialMoved"].clone()),
               (json!("password-not-set"), json!(false), json!(true)), "{p}");
    assert_eq!(p["note"], json!("ok to change"), "the rest of the overlay survives the move");

    // --- switched off: listed, not polled.
    let polled = c.zabbix_sync().await["inUse"].clone();
    let r = save(&c, &oper, "102", json!({ "enabled": false }), json!([])).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(row(&c, &oper, "102").await["enabled"], json!(false));
    assert_eq!(c.zabbix_sync().await["inUse"], json!(polled.as_u64().unwrap() - 1), "not polled");
    save(&c, &oper, "102", json!({}), json!(["enabled"])).await;

    // --- the host disappears: its overlay is kept and shown nowhere; it applies when it returns.
    let gone = hosts.lock().unwrap().remove(1);
    c.zabbix_sync().await;
    assert!(row(&c, &admin, "102").await.is_null());
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(data.join("zabbix-overrides.json")).unwrap()).unwrap();
    assert_eq!(kept["102"]["fields"]["note"], json!("team A"), "orphan kept: {kept}");
    hosts.lock().unwrap().push(gone);
    c.zabbix_sync().await;
    assert_eq!(row(&c, &admin, "102").await["note"], json!("team A"));

    // --- a restart: the overlay is read back and applied at the first sync.
    drop(c);
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();
    c.zabbix_sync().await;
    let admin = zsession(&c, "sara", 3).await;
    let d = row(&c, &admin, "102").await;
    assert_eq!((d["tags"].clone(), d["tls"].clone()), (json!(["eu", "dev"]), json!("system")), "{d}");

    // --- Zabbix was only read.
    let written: Vec<String> = methods.lock().unwrap().iter()
        .filter(|m| m.ends_with(".create") || m.ends_with(".update") || m.ends_with(".delete") || m.ends_with(".massadd")).cloned().collect();
    assert!(written.is_empty(), "no Zabbix write: {written:?}");
}
