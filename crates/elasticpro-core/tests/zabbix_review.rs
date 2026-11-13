//! A Zabbix host at the address of a cluster that exists already (zbx_conflicts.rs), end to end
//! against a fake Zabbix:
//!   * the address is compared as one identity: case, a trailing slash and a default port do not
//!     make another cluster;
//!   * such a host is held — not built, not polled — and the existing cluster is untouched; hosts
//!     that do not conflict keep syncing;
//!   * ZABBIX_SYNC_PREVIEW says what a sync would add and hold, and writes nothing anywhere;
//!   * ZABBIX_CONFLICT_DECIDE is an administrator's (an operator and a user are refused), made on
//!     the values the review showed; Skip, Update and Keep both each do what they say;
//!   * a decision holds across syncs and a restart, and is asked again only when Zabbix's values
//!     for the host change;
//!   * two Zabbix hosts at one address: the one in use stays, the other is held;
//!   * an overlay (ZABBIX_CLUSTER_SAVE) still applies;
//!   * Zabbix is only ever read.
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

/// The fake Zabbix's hosts: (hostid, technical name, visible name, `{$ELASTICSEARCH.HOST}`).
type Hosts = Arc<Mutex<Vec<(String, String, String, String)>>>;

fn host_json(h: &(String, String, String, String)) -> Value {
    let m = |k: &str, v: &str| json!({ "macro": k, "value": v, "type": "0" });
    json!({ "hostid": h.0, "host": h.1, "name": h.2, "hostgroups": [], "tags": [],
            "macros": [m("{$ELASTICSEARCH.HOST}", &h.3), m("{$ELASTICSEARCH.SCHEME}", "http"),
                       m("{$ELASTICSEARCH.USERNAME}", "svc"), m("{$ELASTICSEARCH.PASSWORD}", "pw")] })
}

fn host(id: &str, name: &str, es: &str) -> (String, String, String, String) {
    (id.into(), name.into(), name.into(), es.into())
}

async fn list(c: &Arc<Core>, s: &str) -> Value {
    c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": s })).await
}

fn ids(l: &Value) -> Vec<String> {
    let mut v: Vec<String> = l["clusters"].as_array().unwrap().iter().map(|x| x["_id"].as_str().unwrap().to_string()).collect();
    v.sort();
    v
}

fn held<'a>(l: &'a Value, host_id: &str) -> &'a Value {
    l["held"].as_array().unwrap().iter().find(|e| e["hostId"] == host_id).unwrap_or(&Value::Null)
}

async fn decide(c: &Arc<Core>, s: &str, host_id: &str, decision: &str, fingerprint: &Value) -> Value {
    c.handle(json!({ "type": "ZABBIX_CONFLICT_DECIDE", "session": s, "hostId": host_id, "decision": decision, "fingerprint": fingerprint })).await
}

async fn fleet_ids(c: &Arc<Core>, s: &str) -> String {
    c.handle(json!({ "type": "FLEET_STATE", "session": s })).await["clusterIds"].to_string()
}

#[tokio::test]
async fn a_host_at_an_existing_cluster_s_address_waits_for_an_administrator() {
    let hosts: Hosts = Arc::new(Mutex::new(vec![host("201", "es-a", "10.0.0.1")]));
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

    let dir = TempDir::new("zbx-review");
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    std::env::set_var("ELASTICPRO_CLUSTER_SECRET_KEY", "k".repeat(48));
    let data = TempDir::new("zbx-review-data");
    let record = data.join("zabbix-conflicts.json");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();
    let admin = zsession(&c, "sara", 3).await;
    let oper = zsession(&c, "otto", 2).await;
    let user = zsession(&c, "uma", 1).await;

    // Two config clusters, written as people write addresses: upper case, a trailing slash, a
    // default port left out.
    let r = c.handle(json!({ "type": "PRIME", "session": admin, "clusters": [
        { "id": "lab", "name": "lab", "url": "HTTP://10.0.0.5:9200/", "authHeader": "Basic bGFiOmxhYg==" },
        { "id": "web", "name": "web", "url": "http://10.0.0.9", "authHeader": "Basic d2ViOndlYg==" }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    // --- the first sync, with nothing at those addresses: the record is started, empty.
    let s = c.zabbix_sync().await;
    assert_eq!(s["clusters"], json!(1), "{s}");
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
    assert_eq!(kept["entries"], json!({}), "{kept}");

    // --- Zabbix gains a host at lab's address, one at web's (port 80 written out), and one elsewhere.
    hosts.lock().unwrap().extend([host("202", "lab-zbx", "10.0.0.5"), host("203", "es-new", "10.0.0.7"),
                                  host("205", "web-zbx", "http://10.0.0.9:80/")]);

    // A host whose macros make an address with a credential in it is no cluster at all: never
    // compared with lab's, never sent lab's credential.
    hosts.lock().unwrap().push(host("207", "lab-crafted", "http://lab.example:9200@10.0.0.5:9200"));

    // --- the preview says so, and writes nothing.
    let before = std::fs::read(&record).unwrap();
    let r = c.handle(json!({ "type": "ZABBIX_SYNC_PREVIEW", "session": user })).await;
    assert_eq!(r["kind"], json!("forbidden"), "a user may not: {r}");
    let r = c.handle(json!({ "type": "ZABBIX_SYNC_PREVIEW", "session": oper })).await;
    assert_eq!(r["kind"], json!("forbidden"), "an operator may not: {r}");
    let p = c.handle(json!({ "type": "ZABBIX_SYNC_PREVIEW", "session": admin })).await;
    assert_eq!((p["ok"].clone(), p["dryRun"].clone()), (json!(true), json!(true)), "{p}");
    assert_eq!(p["add"].as_array().unwrap().iter().map(|x| x["hostId"].clone()).collect::<Vec<_>>(), vec![json!("203")], "{p}");
    let mut hold: Vec<String> = p["hold"].as_array().unwrap().iter().map(|x| x["hostId"].as_str().unwrap().to_string()).collect();
    hold.sort();
    assert_eq!(hold, vec!["202", "205"], "{p}");
    assert_eq!(std::fs::read(&record).unwrap(), before, "a dry run writes nothing");
    assert!(p["skipped"].to_string().contains("lab-crafted"), "{p}");
    assert_eq!(ids(&list(&c, &admin).await), vec!["zbx-es-a"], "nor changes the list");
    assert!(list(&c, &admin).await["held"].as_array().unwrap().is_empty());

    // --- the sync: es-new is added; the other two are held and the config clusters untouched.
    let s = c.zabbix_sync().await;
    assert_eq!(s["clusters"], json!(2), "{s}");
    assert!(s["skipped"].to_string().contains("lab-crafted"), "{s}");
    let l = list(&c, &admin).await;
    assert_eq!(ids(&l), vec!["zbx-es-a", "zbx-es-new"], "{l}");
    assert_eq!(l["reviewNeeded"], json!(2), "{l}");
    let lab = held(&l, "202").clone();
    assert_eq!((lab["state"].clone(), lab["existing"]["kind"].clone(), lab["existing"]["id"].clone()),
               (json!("pending"), json!("config"), json!("lab")), "{lab}");
    assert_eq!(lab["identity"], json!("http://10.0.0.5:9200"));
    assert_eq!((lab["existing"]["values"]["name"].clone(), lab["zabbix"]["url"].clone(), lab["zabbix"]["name"].clone()),
               (json!("lab"), json!("http://10.0.0.5:9200"), json!("lab-zbx")), "old and new side by side: {lab}");
    assert!(lab["existing"]["values"]["url"].as_str().unwrap().eq_ignore_ascii_case("http://10.0.0.5:9200/")
            || lab["existing"]["values"]["url"].as_str().unwrap().eq_ignore_ascii_case("http://10.0.0.5:9200"), "{lab}");
    assert_eq!(held(&l, "205")["existing"]["id"], json!("web"), "a default port is the same address");
    assert!(lab["zabbix"]["macros"].as_str().unwrap().contains("HOST=10.0.0.5"), "the macros as Zabbix holds them: {lab}");
    let fleet = fleet_ids(&c, &admin).await;
    assert!(fleet.contains("\"lab\"") && fleet.contains("\"web\"") && !fleet.contains("zbx-lab-zbx") && !fleet.contains("zbx-web-zbx"),
            "held hosts are not polled; the existing clusters are: {fleet}");
    // Below admin: nothing of it.
    let ul = list(&c, &user).await;
    assert_eq!((ul["held"].clone(), ul["reviewNeeded"].clone()), (json!([]), json!(0)), "{ul}");

    // --- who: an administrator's; a stale review is refused.
    let fp = lab["fingerprint"].clone();
    let before = std::fs::read(&record).unwrap();
    for s in [&user, &oper] {
        let r = decide(&c, s, "202", "update", &fp).await;
        assert_eq!(r["kind"], json!("forbidden"), "{r}");
    }
    assert_eq!(decide(&c, &admin, "202", "update", &json!("0000")).await["kind"], json!("changed_since_review"));
    assert_eq!(decide(&c, &admin, "203", "skip", &fp).await["kind"], json!("not_found"), "es-new is not held");
    assert_eq!(decide(&c, &admin, "202", "maybe", &fp).await["kind"], json!("bad_message"));
    assert_eq!(std::fs::read(&record).unwrap(), before, "nothing refused was kept");

    // --- Skip: the host stays out, and a repeat sync does not ask again.
    let r = decide(&c, &admin, "202", "skip", &fp).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["entry"]["state"], json!("decided"));
    c.zabbix_sync().await;
    let l = list(&c, &admin).await;
    assert!(!ids(&l).contains(&"zbx-lab-zbx".to_string()));
    assert_eq!(held(&l, "202")["state"], json!("decided"), "{l}");
    assert!(held(&l, "202")["decidedBy"].as_str().unwrap().starts_with("sara"), "who decided is kept: {l}");
    assert_eq!(l["reviewNeeded"], json!(1), "only web-zbx still waits");

    // --- Update: the host takes lab over; the pages set lab aside by the row's `replaces`.
    let r = decide(&c, &admin, "202", "update", &fp).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let l = list(&c, &admin).await;
    let row = l["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-lab-zbx").cloned().expect("built");
    assert_eq!((row["replaces"]["kind"].clone(), row["replaces"]["id"].clone(), row["review"].clone()),
               (json!("config"), json!("lab"), json!("update")), "{row}");
    assert!(fleet_ids(&c, &admin).await.contains("zbx-lab-zbx"), "polled from now on");

    // --- Keep both: both are clusters, nothing set aside.
    let r = decide(&c, &admin, "202", "keepBoth", &fp).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let l = list(&c, &admin).await;
    let row = l["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == "zbx-lab-zbx").cloned().expect("built");
    assert!(row.get("replaces").is_none(), "{row}");
    assert_eq!(row["review"], json!("keepBoth"));
    assert!(fleet_ids(&c, &admin).await.contains("\"lab\""), "lab is still polled too");

    // --- an overlay still applies to a host let in, and to the others.
    let r = c.handle(json!({ "type": "ZABBIX_CLUSTER_SAVE", "session": oper, "hostId": "202", "set": { "name": "Lab via Zabbix" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = c.handle(json!({ "type": "ZABBIX_CLUSTER_SAVE", "session": oper, "hostId": "203", "set": { "note": "new one" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c.zabbix_sync().await;
    let l = list(&c, &admin).await;
    let name = |id: &str| l["clusters"].as_array().unwrap().iter().find(|x| x["_id"] == id).map(|x| (x["name"].clone(), x["note"].clone()));
    assert_eq!(name("zbx-lab-zbx").unwrap().0, json!("Lab via Zabbix"));
    assert_eq!(name("zbx-es-new").unwrap().1, json!("new one"));
    assert_eq!(held(&l, "202")["state"], json!("decided"), "an edit in ElasticPro is not Zabbix changing: not asked again");

    // --- two Zabbix hosts at one address: the one in use stays, the newcomer is held.
    hosts.lock().unwrap().push(host("199", "es-a-copy", "10.0.0.1"));
    c.zabbix_sync().await;
    let l = list(&c, &admin).await;
    assert!(ids(&l).contains(&"zbx-es-a".to_string()) && !ids(&l).contains(&"zbx-es-a-copy".to_string()), "{l}");
    let dup = held(&l, "199");
    assert_eq!((dup["existing"]["kind"].clone(), dup["existing"]["hostId"].clone()), (json!("zabbix"), json!("201")),
               "the older host id does not win over the one in use: {dup}");

    // --- a restart: the decisions are read back; the duplicate is still held against es-a.
    drop(c);
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();
    let admin = zsession(&c, "sara", 3).await;
    c.handle(json!({ "type": "PRIME", "session": admin, "clusters": [
        { "id": "lab", "name": "lab", "url": "HTTP://10.0.0.5:9200/", "authHeader": "Basic bGFiOmxhYg==" },
        { "id": "web", "name": "web", "url": "http://10.0.0.9", "authHeader": "Basic d2ViOndlYg==" }] })).await;
    c.zabbix_sync().await;
    let l = list(&c, &admin).await;
    assert_eq!(held(&l, "202")["decision"], json!("keepBoth"), "{l}");
    assert!(ids(&l).contains(&"zbx-lab-zbx".to_string()));
    assert_eq!(held(&l, "199")["existing"]["hostId"], json!("201"), "{l}");
    assert_eq!(held(&l, "205")["state"], json!("pending"));

    // --- Zabbix changes the host: the decision still applies, and it is asked again.
    hosts.lock().unwrap().iter_mut().find(|h| h.0 == "202").unwrap().2 = "lab-zbx-renamed".into();
    c.zabbix_sync().await;
    let l = list(&c, &admin).await;
    let e = held(&l, "202");
    assert_eq!((e["state"].clone(), e["decision"].clone()), (json!("changed"), json!("keepBoth")), "{e}");
    assert_eq!(e["decidedValues"]["name"], json!("lab-zbx"));
    assert!(ids(&l).contains(&"zbx-lab-zbx".to_string()), "still applied while asked again");
    // Confirming on the new values settles it.
    let r = decide(&c, &admin, "202", "keepBoth", &e["fingerprint"]).await;
    assert_eq!(r["entry"]["state"], json!("decided"), "{r}");

    // --- Update between Zabbix hosts: the one in use is no longer built.
    let l = list(&c, &admin).await;
    let r = decide(&c, &admin, "199", "update", &held(&l, "199")["fingerprint"]).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let l = list(&c, &admin).await;
    assert!(ids(&l).contains(&"zbx-es-a-copy".to_string()) && !ids(&l).contains(&"zbx-es-a".to_string()), "{l}");
    let r = decide(&c, &admin, "205", "update", &held(&l, "205")["fingerprint"]).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    // --- one cluster is taken over once: a second Update of lab is refused while the first stands.
    hosts.lock().unwrap().push(host("206", "lab-zbx-2", "10.0.0.5"));
    c.zabbix_sync().await;
    let l = list(&c, &admin).await;
    assert_eq!(decide(&c, &admin, "202", "update", &held(&l, "202")["fingerprint"]).await["ok"], json!(true));
    let l = list(&c, &admin).await;
    assert_eq!(held(&l, "206")["state"], json!("pending"), "{l}");
    let r = decide(&c, &admin, "206", "update", &held(&l, "206")["fingerprint"]).await;
    assert_eq!(r["kind"], json!("already_updated"), "{r}");

    // --- Zabbix was only read.
    let written: Vec<String> = methods.lock().unwrap().iter()
        .filter(|m| m.ends_with(".create") || m.ends_with(".update") || m.ends_with(".delete") || m.ends_with(".massadd")).cloned().collect();
    assert!(written.is_empty(), "no Zabbix write: {written:?}");
}
