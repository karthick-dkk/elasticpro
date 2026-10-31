//! "Password is set for all the clusters; a new cluster added with the default credential
//! should not ask for a new password" (0.3.46).
//!
//! The test VM's store held one entry — a password Zabbix handed over for one cluster — and no
//! default, so every cluster added after it had nothing to fall back to and the page asked for
//! a password. This proves, end to end:
//!   * CREDENTIAL_STATUS offers the entries that could become the default (`promotable`);
//!   * CREDENTIAL_PROMOTE makes one the default without the password being typed, refuses to
//!     replace an existing default unless told to, is an admin's only, and logs who and from
//!     where — never the secret;
//!   * a config cluster added afterwards (PRIME, or an operator's CLUSTER_SAVE) signs in with it,
//!     and PRIME says so (`held`, `defaultCredential`);
//!   * a Zabbix cluster with no password of its own takes it on the next sync;
//!   * PRIME falls back to the message's shared credential where nothing is kept.
//!
//! Its own test binary: ELASTICPRO_CONFIG, the Zabbix API settings and the tracing subscriber
//! are process-wide.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use support::{TempDir, TestServer};

const SECRET: &str = "default-credential-secret-0123456789abcdef";
const ZBX_PW: &str = "zbx-handed-over-pw-4711";

static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Capture {
        self.clone()
    }
}

/// The process's one subscriber: the audit target, as JSON lines.
fn capture() -> &'static Capture {
    static CAP: OnceLock<Capture> = OnceLock::new();
    CAP.get_or_init(|| {
        let cap = Capture::default();
        let filter = tracing_subscriber::EnvFilter::new("error,audit=info");
        tracing_subscriber::fmt().json().with_env_filter(filter).with_writer(cap.clone()).init();
        cap
    })
}

fn audit_lines() -> Vec<Value> {
    String::from_utf8(capture().0.lock().unwrap().clone()).unwrap().lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["target"] == json!("audit")).collect()
}

fn basic(user: &str, pw: &str) -> String {
    use base64::Engine as _;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pw}")))
}

async fn zabbix_session(c: &Arc<Core>, user: &str, ty: i64) -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let body = serde_json::to_vec(&json!({ "username": user, "zabbix_user_type": ty, "groups": [],
        "ts": ts.as_secs(), "nonce": format!("nonce-{}-{user}", ts.as_nanos()) })).unwrap();
    let (_, out) = c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body));
    c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await["session"].as_str().unwrap().to_string()
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": "correct-horse-battery" })).await;
    assert_eq!(ch["ok"], json!(true));
    s
}

/// The Zabbix module's half: a password handed over for one cluster host, signed.
fn hand_over(c: &Arc<Core>, cluster: &str, user: &str, password: &str) {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let body = serde_json::to_vec(&json!({ "cluster": cluster, "user": user, "password": password, "set_by": "zabbix-admin",
        "ts": ts.as_secs(), "nonce": format!("n-{}-{cluster}", ts.as_nanos()) })).unwrap();
    let r = c.zabbix_cluster_secret_from(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body), None);
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
}

async fn health(c: &Arc<Core>, s: &str, id: &str) -> Value {
    c.handle(json!({ "type": "ES", "session": s, "clusterId": id, "method": "GET", "path": "/_cluster/health" })).await
}

/// A fake Zabbix with two cluster hosts: the one whose password it handed over (its own, on the
/// host), and a new one with no password of its own — the default's to sign in.
async fn fake_zabbix(own_url: &str, new_url: &str) -> TestServer {
    let split = |u: &str| {
        let rest = u.trim_start_matches("http://");
        let (h, p) = rest.split_once(':').unwrap();
        (h.to_string(), p.trim_end_matches('/').to_string())
    };
    let (own_h, own_p) = split(own_url);
    let (new_h, new_p) = split(new_url);
    TestServer::with(move |hit| {
        let b: Value = serde_json::from_str(&hit.body).unwrap();
        let p = &b["params"];
        let m = |k: &str, v: &str| json!({ "macro": k, "value": v, "type": "0" });
        let secret = |k: &str| json!({ "macro": k, "type": "1" });
        let result = match b["method"].as_str().unwrap() {
            "template.get" => json!([{ "templateid": "900", "host": "Elasticsearch Cluster by HTTP EP", "macros": [] }]),
            "usermacro.get" if p["globalmacro"] == json!(true) => json!([m("{$ELASTICSEARCH.USERNAME}", "svc-es"), secret("{$ELASTICSEARCH.PASSWORD}")]),
            "usermacro.get" => json!([]),
            "host.get" if p["templateids"] == json!(["900"]) => json!([
                { "hostid": "1", "host": "Local-ES-Cluster", "name": "Local-ES-Cluster", "hostgroups": [],
                  "macros": [m("{$ELASTICSEARCH.HOST}", &own_h), m("{$ELASTICSEARCH.PORT}", &own_p), m("{$ELASTICSEARCH.SCHEME}", "http"),
                             m("{$ELASTICSEARCH.USERNAME}", "zabbix"), secret("{$ELASTICSEARCH.PASSWORD}")] },
                { "hostid": "2", "host": "new-from-zabbix", "name": "new-from-zabbix", "hostgroups": [],
                  "macros": [m("{$ELASTICSEARCH.HOST}", &new_h), m("{$ELASTICSEARCH.PORT}", &new_p), m("{$ELASTICSEARCH.SCHEME}", "http")] },
            ]),
            "host.get" => json!([]),
            "usergroup.get" => json!([]),
            other => panic!("unexpected Zabbix call {other} {p}"),
        };
        (200, json!({ "jsonrpc": "2.0", "result": result, "id": 1 }).to_string())
    }).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_credential_becomes_the_default_and_a_new_cluster_asks_for_nothing() {
    let _turn = ENV.lock().await;
    capture();
    let dir = TempDir::new("default-cred");
    let own_es = TestServer::start().await;
    let new_zbx_es = TestServer::start().await;
    let alpha = TestServer::start().await;
    let beta = TestServer::start().await;
    let gamma = TestServer::start().await;
    let zbx = fake_zabbix(&own_es.url(), &new_zbx_es.url()).await;
    std::fs::write(dir.join("zbx-token"), "zbx-token\n").unwrap();
    std::env::set_var("ELASTICPRO_ZABBIX_API_URL", format!("{}/api_jsonrpc.php", zbx.url()));
    std::env::set_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE", dir.join("zbx-token"));
    // A config file with no credential at all, as on the test VM.
    let cfg = dir.join("config_cluster.json");
    std::fs::write(&cfg, serde_json::to_string_pretty(&json!({ "version": 2, "clusters": [{ "name": "Alpha", "url": alpha.url() }] })).unwrap()).unwrap();
    std::env::set_var("ELASTICPRO_CONFIG", &cfg);
    let data = TempDir::new("default-cred-data");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();

    // The VM's state: one password Zabbix handed over, for one cluster, and no default.
    hand_over(&c, "Local-ES-Cluster", "zabbix", ZBX_PW);
    let a = admin(&c).await;
    let sync = c.zabbix_sync().await;
    assert_eq!(sync["inUse"], json!(1), "only the cluster whose own password was handed over: {sync}");

    let st = c.handle(json!({ "type": "CREDENTIAL_STATUS", "session": a })).await;
    assert_eq!(st["default"], Value::Null, "{st}");
    assert_eq!(st["promotable"], json!([{ "id": "Local-ES-Cluster", "cluster": "Local-ES-Cluster", "source": "zabbix",
        "user": "zabbix", "kind": "basic", "setBy": "zabbix-admin", "setAt": st["promotable"][0]["setAt"] }]), "{st}");
    assert!(!st.to_string().contains(ZBX_PW));

    // A cluster added now has nothing to sign in with: the page is told, and would ask.
    let r = c.handle(json!({ "type": "PRIME", "session": a, "readOnly": true,
        "clusters": [{ "id": "alpha", "name": "Alpha", "url": alpha.url() }] })).await;
    assert_eq!((r["held"].clone(), r["defaultCredential"].clone()), (json!([]), json!(false)), "{r}");
    let op = zabbix_session(&c, "otto", 2).await;
    let r = c.handle(json!({ "type": "CLUSTER_SAVE", "session": op, "cluster": { "name": "Gamma", "url": gamma.url() } })).await;
    assert_eq!((r["ok"].clone(), r["credential"].clone()), (json!(true), json!("none")), "an operator is told no default is set: {r}");

    // Nobody below admin makes a default.
    for s in [&op, &zabbix_session(&c, "ursula", 1).await] {
        let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": s, "from": "Local-ES-Cluster" })).await;
        assert_eq!(r["kind"], json!("forbidden"), "{r}");
    }
    let st = c.handle(json!({ "type": "CREDENTIAL_STATUS", "session": a })).await;
    assert_eq!(st["default"], Value::Null, "a refused promote kept nothing: {st}");
    let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": a, "from": "*" })).await;
    assert_eq!(r["kind"], json!("bad_message"), "{r}");
    let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": a, "from": "nowhere" })).await;
    assert_eq!(r["kind"], json!("not_found"), "{r}");
    let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": a })).await;
    assert_eq!(r["kind"], json!("bad_message"), "{r}");

    // The admin makes it the default: nothing typed, nothing sent back but the username.
    let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": a, "from": "Local-ES-Cluster" })).await;
    assert_eq!((r["ok"].clone(), r["cluster"].clone(), r["from"].clone(), r["user"].clone(), r["kind"].clone(), r["replaced"].clone()),
               (json!(true), json!("*"), json!("Local-ES-Cluster"), json!("zabbix"), json!("basic"), json!(false)), "{r}");
    assert!(!r.to_string().contains(ZBX_PW));
    let st = c.handle(json!({ "type": "CREDENTIAL_STATUS", "session": a })).await;
    assert_eq!((st["default"]["user"].clone(), st["default"]["setBy"].clone()), (json!("zabbix"), json!("Admin")), "{st}");
    assert_eq!(st["promotable"], json!([]), "with a default there is nothing to offer: {st}");

    // Alpha, polled already, signs in with it at once; Gamma, the operator's, too.
    let want = basic("zabbix", ZBX_PW);
    assert_eq!(health(&c, &a, "alpha").await["ok"], json!(true));
    assert_eq!(alpha.last_hit().unwrap().header("authorization"), Some(want.as_str()));
    assert_eq!(health(&c, &a, "gamma").await["ok"], json!(true));
    assert_eq!(gamma.last_hit().unwrap().header("authorization"), Some(want.as_str()));
    // A new cluster on the next page load: held, and the page is told the default covers it.
    let r = c.handle(json!({ "type": "PRIME", "session": a, "readOnly": true,
        "clusters": [{ "id": "alpha", "name": "Alpha", "url": alpha.url() }, { "id": "beta", "name": "Beta", "url": beta.url() }] })).await;
    assert_eq!((r["held"].clone(), r["defaultCredential"].clone()), (json!(["alpha", "beta"]), json!(true)), "{r}");
    assert!(!r.to_string().contains(ZBX_PW) && !r.to_string().contains(&want), "PRIME's answer carries no credential: {r}");
    assert_eq!(health(&c, &a, "beta").await["ok"], json!(true));
    assert_eq!(beta.last_hit().unwrap().header("authorization"), Some(want.as_str()));
    // An operator's next cluster is "shared": it signs in with no admin in between.
    let delta = TestServer::start().await;
    let r = c.handle(json!({ "type": "CLUSTER_SAVE", "session": op, "cluster": { "name": "Delta", "url": delta.url() } })).await;
    assert_eq!(r["credential"], json!("shared"), "{r}");
    assert_eq!(health(&c, &op, "delta").await["ok"], json!(true));
    assert_eq!(delta.last_hit().unwrap().header("authorization"), Some(want.as_str()));

    // A Zabbix cluster with no password of its own takes the default on the next sync.
    let sync = c.zabbix_sync().await;
    assert_eq!(sync["inUse"], json!(2), "{sync}");
    let list = c.handle(json!({ "type": "ZABBIX_CLUSTERS", "session": a })).await;
    let row = list["clusters"].as_array().unwrap().iter().find(|v| v["zabbixHost"] == json!("new-from-zabbix")).cloned().unwrap();
    assert_eq!((row["credential"].clone(), row["credentialOk"].clone()), (json!("core-default"), json!(true)), "{list}");
    assert_eq!(health(&c, &a, "zbx-new-from-zabbix").await["ok"], json!(true));
    assert_eq!(new_zbx_es.last_hit().unwrap().header("authorization"), Some(basic("zabbix", ZBX_PW).as_str()));

    // An existing default is not replaced unless the message says so.
    let r = c.handle(json!({ "type": "CREDENTIAL_SET", "session": a, "cluster": "alpha", "apiKey": "YWxwaGE6a2V5" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": a, "from": "alpha" })).await;
    assert_eq!(r["kind"], json!("exists"), "{r}");
    assert!(r["message"].as_str().unwrap().contains("zabbix"), "it names what is set: {r}");
    health(&c, &a, "beta").await;
    assert_eq!(beta.last_hit().unwrap().header("authorization"), Some(want.as_str()), "the refused promote changed nothing");
    // A config cluster's id is enough; its binding does not come along.
    let r = c.handle(json!({ "type": "CREDENTIAL_PROMOTE", "session": a, "from": "alpha", "replace": true })).await;
    assert_eq!((r["ok"].clone(), r["from"].clone(), r["kind"].clone(), r["replaced"].clone()),
               (json!(true), json!("cfg:alpha"), json!("header"), json!(true)), "{r}");
    health(&c, &a, "beta").await;
    assert_eq!(beta.last_hit().unwrap().header("authorization"), Some("ApiKey YWxwaGE6a2V5"));

    // Audited: who, and from which entry — never the secret.
    let promoted: Vec<Value> = audit_lines().into_iter()
        .filter(|v| v["fields"]["message"] == json!("kept credential made the default")).collect();
    assert_eq!(promoted.len(), 2, "{promoted:?}");
    assert_eq!((promoted[0]["fields"]["user"].clone(), promoted[0]["fields"]["from"].clone(), promoted[0]["fields"]["replaced"].clone()),
               (json!("Admin"), json!("Local-ES-Cluster"), json!(false)), "{promoted:?}");
    assert_eq!((promoted[1]["fields"]["from"].clone(), promoted[1]["fields"]["replaced"].clone()), (json!("cfg:alpha"), json!(true)));
    let all = String::from_utf8(capture().0.lock().unwrap().clone()).unwrap();
    assert!(!all.contains(ZBX_PW) && !all.contains("YWxwaGE6a2V5") && !all.contains(&want), "a secret reached the log");
    for f in ["cluster-secrets.json", "primed.json"] {
        let text = std::fs::read_to_string(data.join(f)).unwrap_or_default();
        assert!(!text.contains(ZBX_PW) && !text.contains(&want), "{f} holds a credential in the clear");
    }
    std::env::remove_var("ELASTICPRO_ZABBIX_API_URL");
    std::env::remove_var("ELASTICPRO_ZABBIX_API_TOKEN_FILE");
    std::env::remove_var("ELASTICPRO_CONFIG");
}

/// Where the server keeps nothing (no default, nothing of the cluster's own, nothing held from
/// before), a PRIME's shared credential is what a config cluster signs in with — as CLUSTER_SAVE
/// already did. The store here cannot keep anything (a key that is too short), so the shared
/// credential is not turned into a kept default first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prime_falls_back_to_the_shared_credential_where_nothing_is_kept() {
    let _turn = ENV.lock().await;
    capture();
    std::env::set_var("ELASTICPRO_CLUSTER_SECRET_KEY", "too-short");
    let data = TempDir::new("default-cred-shared");
    let c = Core::new_with_rounds(Some(data.0.clone()), Edition::Hosted, 1);
    std::env::remove_var("ELASTICPRO_CLUSTER_SECRET_KEY");
    let a = admin(&c).await;
    let alpha = TestServer::start().await;
    let shared = basic("fleet", "fleet-pw");
    let r = c.handle(json!({ "type": "PRIME", "session": a, "readOnly": true, "sharedAuthHeader": shared, "persist": false,
        "clusters": [{ "id": "alpha", "name": "Alpha", "url": alpha.url() }] })).await;
    assert_eq!((r["held"].clone(), r["defaultCredential"].clone()), (json!(["alpha"]), json!(true)), "{r}");
    assert_eq!(health(&c, &a, "alpha").await["ok"], json!(true));
    assert_eq!(alpha.last_hit().unwrap().header("authorization"), Some(shared.as_str()));
    let st = c.handle(json!({ "type": "CREDENTIAL_STATUS", "session": a })).await;
    assert!(st["problem"].is_string() && st["default"].is_null(), "nothing was kept: {st}");
    // "None, on purpose" still wins over the shared one.
    let r = c.handle(json!({ "type": "PRIME", "session": a, "readOnly": true, "persist": false,
        "clusters": [{ "id": "alpha", "name": "Alpha", "url": alpha.url(), "authHeader": "" }] })).await;
    assert_eq!((r["held"].clone(), r["anonymous"].clone()), (json!([]), json!(["alpha"])), "{r}");
    // And a message that clears the shared one leaves nothing to fall back to.
    let r = c.handle(json!({ "type": "PRIME", "session": a, "readOnly": true, "persist": false, "sharedAuthHeader": "",
        "clusters": [{ "id": "beta", "name": "Beta", "url": alpha.url() }] })).await;
    assert_eq!((r["held"].clone(), r["defaultCredential"].clone()), (json!([]), json!(false)), "{r}");
}
