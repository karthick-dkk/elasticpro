//! The Zabbix connection as Config → Zabbix sets it up: the link store, precedence under
//! the server's own settings, the admin-only messages, and the pairing handshake the
//! Zabbix module completes at `POST /zabbix/pair` — through the real message API and the
//! same entry points the bridge binary calls.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_link::{decode_pairing_code, ServerZbx, PAIR_PER_MIN, PAIR_TTL_SECS};
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{TempDir, TestServer};

const PASSWORD: &str = "correct-horse-battery";
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const EP: &str = "https://ep.example.com";

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn core(dir: &TempDir, server: ServerZbx) -> Arc<Core> {
    Core::new_with_server_zbx(Some(dir.0.clone()), Edition::Hosted, 1, server)
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(c) })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn user(c: &Arc<Core>, admin: &str, name: &str, role: &str) -> String {
    let add = c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role })).await;
    assert_eq!(add["ok"], json!(true), "{add}");
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    res["session"].as_str().unwrap().to_string()
}

async fn send(c: &Arc<Core>, s: &str, mut msg: Value) -> Value {
    msg["session"] = json!(s);
    c.handle(msg).await
}

/// A Zabbix API that knows the handful of methods the probe and the sync ask.
async fn mock_zabbix() -> TestServer {
    TestServer::with(|hit| {
        let req: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
        let method = req["method"].as_str().unwrap_or("");
        let authed = hit.header("authorization") == Some(&format!("Bearer {TOKEN}"));
        let result = match method {
            "apiinfo.version" => json!("7.0.5"),
            _ if !authed => return (200, json!({ "jsonrpc": "2.0", "id": 1,
                "error": { "code": -32602, "message": "Invalid params.", "data": "Not authorised." } }).to_string()),
            "template.get" => json!([{ "templateid": "1", "host": "Elasticsearch Cluster by HTTP EP", "macros": [] }]),
            _ => json!([]),
        };
        (200, json!({ "jsonrpc": "2.0", "id": 1, "result": result }).to_string())
    }).await
}

/// Begin a pairing for `zabbix` as the admin; the code's contents.
async fn begin(c: &Arc<Core>, s: &str, zabbix: &str) -> Value {
    let r = send(c, s, json!({ "type": "ZABBIX_PAIR_BEGIN", "zabbixUrl": zabbix, "epUrl": EP })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let code = decode_pairing_code(r["code"].as_str().unwrap()).expect("a decodable pairing code");
    assert_eq!(code["v"], json!(1));
    assert_eq!(code["ep"], json!(EP));
    assert_eq!(code["exp"], r["exp"]);
    code
}

fn pair_body(code: &Value, zabbix: &str, api: &str, ts: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "nonce": code["nonce"], "zabbixUrl": zabbix, "apiUrl": api, "apiToken": TOKEN,
        "zabbixVersion": "7.0.5", "ts": ts,
    })).unwrap()
}

fn sign(secret: &str, body: &[u8]) -> String {
    ZabbixSso::sign(secret.as_bytes(), body)
}

fn sso_body(user: &str, ty: i64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "username": user, "zabbix_user_type": ty, "groups": [], "ts": now(),
        "nonce": format!("n-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()),
    })).unwrap()
}

fn sso_status(c: &Arc<Core>, secret: &str) -> u16 {
    let b = sso_body("zed", 3);
    c.zabbix_sso_init(&b, &sign(secret, &b)).0
}

async fn allow_http(c: &Arc<Core>, s: &str) {
    let r = send(c, s, json!({ "type": "ZABBIX_LINK_SET", "allowHttp": true })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

/// Everything the admin's pages receive, as one string, to search for secrets in.
fn assert_no_secret(v: &Value, secrets: &[&str]) {
    let s = v.to_string();
    for sec in secrets {
        assert!(!s.contains(sec), "a secret leaked into a message answer: {s}");
    }
}

/* ---------------------------------------- store ---------------------------------------- */

#[tokio::test]
async fn the_store_is_private_and_written_whole() {
    let dir = TempDir::new("zlink-store");
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "zabbixUrl": "https://zbx.example.com/", "apiToken": TOKEN,
                                 "allowedSources": ["10.0.0.0/24"], "syncSecs": 120 })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["zabbixUrl"], json!("https://zbx.example.com"));
    assert_eq!(r["apiUrl"], json!("https://zbx.example.com/api_jsonrpc.php"), "the API address defaults from the frontend's");
    assert_eq!(r["apiUrlIsDefault"], json!(true));
    let p = dir.join("zabbix-link.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!dir.join("zabbix-link.json.tmp").exists(), "no temporary file is left behind");
    let on_disk: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    assert_eq!(on_disk["apiToken"], json!(TOKEN), "the file is where the token lives");
    assert_eq!(on_disk["syncSecs"], json!(120));

    // A restart reads it back.
    drop(c);
    let c2 = core(&dir, ServerZbx::default());
    let s2 = admin_again(&c2).await;
    let g = send(&c2, &s2, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(g["zabbixUrl"], json!("https://zbx.example.com"));
    assert_eq!(g["apiToken"]["set"], json!(true));
    assert_eq!(g["apiToken"]["by"], json!("elasticpro"));
    assert_eq!(g["allowedSources"], json!(["10.0.0.0/24"]));
    assert_no_secret(&g, &[TOKEN]);
}

async fn admin_again(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": PASSWORD })).await;
    res["session"].as_str().expect("a session").to_string()
}

#[tokio::test]
async fn set_validates_and_refuses_what_it_does_not_own() {
    let dir = TempDir::new("zlink-validate");
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    for (msg, why) in [
        (json!({ "zabbixUrl": "http://zbx.lan" }), "plain http without the lab switch"),
        (json!({ "zabbixUrl": "zbx.lan" }), "not a URL"),
        (json!({ "zabbixUrl": "https://u:p@zbx.lan" }), "credentials in the URL"),
        (json!({ "apiToken": "short" }), "a token too short"),
        (json!({ "apiToken": format!("{TOKEN}\r\nX-Evil: 1") }), "a token that would break a header"),
        (json!({ "allowedSources": ["10.0.0.0/40"] }), "a bad CIDR"),
        (json!({ "syncSecs": 5 }), "an interval below 30 s"),
        (json!({ "ssoSecret": "a".repeat(40) }), "the sign-in secret, which only pairing sets"),
        (json!({ "pairedAt": 1 }), "an unknown field"),
    ] {
        let mut m = msg.clone();
        m["type"] = json!("ZABBIX_LINK_SET");
        let r = send(&c, &s, m).await;
        assert_eq!(r["ok"], json!(false), "{why} was accepted: {r}");
    }
    // Every refusal is on the record, with who tried.
    let g = send(&c, &s, json!({ "type": "ZABBIX_LINK_GET" })).await;
    let evs = g["events"].as_array().unwrap();
    assert!(evs.iter().all(|e| e["ok"] == json!(false) && e["by"] == json!("elasticpro") && e["action"] == json!("set")), "{g}");
    assert!(evs.len() >= 9, "{g}");
    // With the lab switch, http is fine, and turning the switch off again is refused while
    // an http address is stored.
    allow_http(&c, &s).await;
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "zabbixUrl": "http://zbx.lan:8080" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "allowHttp": false })).await;
    assert_eq!(r["ok"], json!(false), "{r}");
}

/* ------------------------------------- precedence ------------------------------------- */

#[tokio::test]
async fn the_server_configuration_wins_field_by_field() {
    let dir = TempDir::new("zlink-precedence");
    let server = ServerZbx {
        api_url: Some("http://zabbix-web:8080/api_jsonrpc.php".into()),
        api_token: Some("server-token-0123456789abcdef".into()),
        sso_secret: Some("server-secret-0123456789abcdef-0123456789".into()),
        ..Default::default()
    };
    let c = core(&dir, server);
    let s = admin(&c).await;
    let g = send(&c, &s, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(g["managed"], json!({ "zabbixUrl": false, "apiUrl": true, "apiToken": true, "ssoSecret": true,
                                     "verifyTls": false, "allowedSources": false, "syncSecs": false }));
    assert_eq!(g["apiUrl"], json!("http://zabbix-web:8080/api_jsonrpc.php"));
    assert_eq!(g["apiToken"], json!({ "set": true, "source": "server", "at": null, "by": null }));
    assert_eq!(g["ssoSecret"], json!({ "set": true, "source": "server" }));
    assert_eq!(g["signIn"], json!(true), "the server's secret is the one sign-in uses");
    assert_no_secret(&g, &["server-token", "server-secret"]);

    // What the server owns cannot be changed here; what it does not own can.
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "apiToken": TOKEN })).await;
    assert_eq!(r["ok"], json!(false));
    assert!(r["message"].as_str().unwrap().contains("managed by the server"), "{r}");
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "zabbixUrl": "https://zbx.example.com", "syncSecs": 600 })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["apiUrl"], json!("http://zabbix-web:8080/api_jsonrpc.php"), "the server's API address still wins");
    assert_eq!(r["syncSecs"], json!(600));
    // The frame follows the known Zabbix frontend once sign-in is on.
    assert_eq!(c.frame_ancestors(), "https://zbx.example.com");

    // Pairing would hand the module a secret the server then overrides: refused.
    let r = send(&c, &s, json!({ "type": "ZABBIX_PAIR_BEGIN", "zabbixUrl": "https://zbx.example.com", "epUrl": EP })).await;
    assert_eq!(r["ok"], json!(false), "{r}");
    assert!(r["code"].is_null());
    // Unpairing removes only what is stored here; the server's settings stay in force.
    let r = send(&c, &s, json!({ "type": "ZABBIX_UNPAIR" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["ssoSecret"]["source"], json!("server"));
    assert_eq!(sso_status(&c, "server-secret-0123456789abcdef-0123456789"), 200);
}

#[tokio::test]
async fn a_server_frame_ancestors_value_wins() {
    let dir = TempDir::new("zlink-csp-server");
    let c = core(&dir, ServerZbx { frame_ancestors: Some("https://a.example https://b.example".into()), ..Default::default() });
    assert_eq!(c.frame_ancestors(), "https://a.example https://b.example");
}

/* ------------------------------------ who may ask ------------------------------------ */

#[tokio::test]
async fn only_an_admin_reaches_the_link() {
    let dir = TempDir::new("zlink-admin");
    let c = core(&dir, ServerZbx::default());
    let a = admin(&c).await;
    let op = user(&c, &a, "olga", "operator").await;
    let us = user(&c, &a, "ulf", "user").await;
    let msgs = [
        json!({ "type": "ZABBIX_LINK_GET" }),
        json!({ "type": "ZABBIX_LINK_SET", "syncSecs": 60 }),
        json!({ "type": "ZABBIX_LINK_TEST" }),
        json!({ "type": "ZABBIX_PAIR_BEGIN", "zabbixUrl": "https://zbx.example.com", "epUrl": EP }),
        json!({ "type": "ZABBIX_UNPAIR" }),
    ];
    for m in &msgs {
        assert_eq!(c.handle(m.clone()).await["kind"], json!("unauthenticated"), "{m}");
        for s in [&op, &us] {
            let r = send(&c, s, m.clone()).await;
            assert_eq!(r["kind"], json!("forbidden"), "{m} → {r}");
        }
    }
    // Nothing the refused callers sent changed anything.
    let g = send(&c, &a, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(g["syncSecs"], json!(300));
    assert!(g["pending"].is_null());
    // The admin's change is on the record, by name.
    let r = send(&c, &a, json!({ "type": "ZABBIX_LINK_SET", "syncSecs": 60 })).await;
    assert_eq!(r["events"][0]["by"], json!("elasticpro"));
    assert_eq!(r["events"][0]["detail"], json!("changed syncSecs"));
    assert_eq!(r["changed"], json!(["syncSecs"]));
}

#[tokio::test]
async fn the_portable_build_has_no_link() {
    let c = Core::new_with_rounds(None, Edition::Portable, 1);
    let r = c.handle(json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(r["supported"], json!(false));
    assert_eq!(c.zabbix_pair(b"{}", "", None).0, 404);
}

/* -------------------------------------- pairing -------------------------------------- */

#[tokio::test]
async fn pairing_happy_path_then_sign_in_and_sync() {
    let dir = TempDir::new("zlink-pair");
    let zbx = mock_zabbix().await;
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    allow_http(&c, &s).await;
    assert_eq!(c.frame_ancestors(), "'none'", "nobody may frame an unpaired app");

    let code = begin(&c, &s, &zbx.url()).await;
    let secret = code["secret"].as_str().unwrap().to_string();
    assert!(secret.len() >= 43, "32 random bytes");
    assert!(code["exp"].as_u64().unwrap() >= now() + PAIR_TTL_SECS - 5);
    let g = send(&c, &s, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(g["pending"]["by"], json!("elasticpro"));
    assert_eq!(g["paired"], json!(false));
    assert_no_secret(&g, &[&secret]);

    let api = format!("{}/api_jsonrpc.php", zbx.url());
    let body = pair_body(&code, &format!("{}/", zbx.url()), &api, now());
    let (st, out) = c.zabbix_pair(&body, &sign(&secret, &body), None);
    assert_eq!(st, 200, "{out}");
    assert_eq!(out["ok"], json!(true));
    assert!(out["epVersion"].is_string());

    let g = send(&c, &s, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(g["paired"], json!(true), "{g}");
    assert_eq!(g["pairedBy"], json!("elasticpro"));
    assert_eq!(g["zabbixVersion"], json!("7.0.5"));
    assert_eq!(g["apiUrl"], json!(api));
    assert_eq!(g["apiToken"]["set"], json!(true));
    assert_eq!(g["ssoSecret"], json!({ "set": true, "source": "ui" }));
    assert!(g["pending"].is_null(), "the nonce is spent");
    assert_no_secret(&g, &[&secret, TOKEN]);
    assert!(g["events"].as_array().unwrap().iter().any(|e| e["action"] == json!("pair") && e["ok"] == json!(true)));

    // The secret from the pairing is the one /sso/zabbix verifies now.
    assert_eq!(sso_status(&c, &secret), 200);
    // The frame follows the pairing.
    assert_eq!(c.frame_ancestors(), zbx.url());

    // The stored token works: the test and the sync both reach the mock with it.
    let t = send(&c, &s, json!({ "type": "ZABBIX_LINK_TEST" })).await;
    assert_eq!(t["ok"], json!(true), "{t}");
    assert_eq!(t["version"], json!("7.0.5"));
    assert_eq!(t["template"]["found"], json!(true));
    assert_no_secret(&t, &[TOKEN, &secret]);
    let sy = send(&c, &s, json!({ "type": "ZABBIX_SYNC" })).await;
    assert_eq!(sy["ok"], json!(true), "{sy}");
    assert!(zbx.hits().iter().any(|h| h.header("authorization") == Some(&format!("Bearer {TOKEN}"))));

    // The same body again: the pairing is over, and it looks like any other refusal.
    let (st, out) = c.zabbix_pair(&body, &sign(&secret, &body), None);
    assert_eq!((st, out["kind"].clone()), (401, json!("unauthorized")), "{out}");

    // After a restart the paired secret still signs people in.
    drop(c);
    let c2 = core(&dir, ServerZbx::default());
    assert_eq!(sso_status(&c2, &secret), 200);
    assert_eq!(c2.frame_ancestors(), zbx.url());

    // Unpairing: the secret and the token go, sign-in stops, nobody may frame the app.
    let s2 = admin_again(&c2).await;
    let r = send(&c2, &s2, json!({ "type": "ZABBIX_UNPAIR" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["paired"], json!(false));
    assert_eq!(r["apiToken"]["set"], json!(false));
    assert_eq!(sso_status(&c2, &secret), 503);
    assert_eq!(c2.frame_ancestors(), "'none'");
    let on_disk = String::from_utf8(std::fs::read(dir.join("zabbix-link.json")).unwrap()).unwrap();
    assert!(!on_disk.contains(&secret) && !on_disk.contains(TOKEN), "unpair removes both from the file");
    assert!(r["events"].as_array().unwrap().iter().any(|e| e["action"] == json!("unpair") && e["by"] == json!("elasticpro")));
}

#[tokio::test]
async fn pairing_refusals() {
    let dir = TempDir::new("zlink-refuse");
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    let zurl = "https://zbx.example.com";
    let api = "https://zbx.example.com/api_jsonrpc.php";

    // Nothing in progress: refused, generically.
    let fake = pair_body(&json!({ "nonce": "x" }), zurl, api, now());
    let (st, out) = c.zabbix_pair(&fake, &sign("whatever-secret-0123456789abcdef0123", &fake), None);
    assert_eq!((st, out["kind"].clone()), (401, json!("unauthorized")));

    let code = begin(&c, &s, zurl).await;
    let secret = code["secret"].as_str().unwrap().to_string();

    // Unsigned and wrongly signed: the same generic answer; the body is never looked at.
    let body = pair_body(&code, zurl, api, now());
    assert_eq!(c.zabbix_pair(&body, "", None).1["kind"], json!("unauthorized"));
    let (st, out) = c.zabbix_pair(&body, &sign("another-secret-0123456789abcdef-0123", &body), None);
    assert_eq!((st, out["kind"].clone(), out["message"].clone()), (401, json!("unauthorized"), json!("pairing refused")));

    // Signed with the pairing secret, the reasons are specific.
    let mut wrong = code.clone();
    wrong["nonce"] = json!("not-the-nonce-000000000000000000");
    let b = pair_body(&wrong, zurl, api, now());
    let (st, out) = c.zabbix_pair(&b, &sign(&secret, &b), None);
    assert_eq!((st, out["kind"].clone()), (401, json!("nonce_mismatch")), "{out}");

    let b = pair_body(&code, "https://zbx.example.com.evil.io", api, now());
    let (st, out) = c.zabbix_pair(&b, &sign(&secret, &b), None);
    assert_eq!((st, out["kind"].clone()), (401, json!("origin_mismatch")), "{out}");
    // Replaying a signed body is refused as such, whatever it was refused for before.
    let (_, out) = c.zabbix_pair(&b, &sign(&secret, &b), None);
    assert_eq!(out["kind"], json!("replayed"), "{out}");

    let b = pair_body(&code, zurl, api, now() - 120);
    assert_eq!(c.zabbix_pair(&b, &sign(&secret, &b), None).1["kind"], json!("stale"));

    let b = pair_body(&code, zurl, "http://zbx.example.com/api_jsonrpc.php", now());
    assert_eq!(c.zabbix_pair(&b, &sign(&secret, &b), None).1["kind"], json!("bad_request"), "no token over plain http unless the pairing was for http");

    let b = b"{\"not\":\"a pairing\"}".to_vec();
    assert_eq!(c.zabbix_pair(&b, &sign(&secret, &b), None).1["kind"], json!("bad_request"));

    // Expired: fifteen minutes on, even a perfect request is refused, and the pairing is gone.
    let later = now() + PAIR_TTL_SECS + 1;
    let b = pair_body(&code, zurl, api, later);
    let e = c.zabbix_link().complete_pair(&b, &sign(&secret, &b), None, later).unwrap_err();
    assert_eq!(e.kind(), "expired");
    let b = pair_body(&code, zurl, api, now());
    // (From another source: this one has spent its budget of ten a minute on the above.)
    let other = Some("10.7.7.7".parse().unwrap());
    assert_eq!(c.zabbix_pair(&b, &sign(&secret, &b), other).1["kind"], json!("unauthorized"), "an expired pairing is no pairing");
    assert_eq!(c.zabbix_pair(&b, &sign(&secret, &b), None).0, 429, "and the source that tried ten times is rate limited");

    // None of that paired anything, and every attempt is on the record.
    let g = send(&c, &s, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(g["paired"], json!(false));
    assert_eq!(g["ssoSecret"]["set"], json!(false));
    let failed = g["events"].as_array().unwrap().iter().filter(|e| e["action"] == json!("pair") && e["ok"] == json!(false)).count();
    assert!(failed >= 8, "every failed pairing is audited (the status shows the last ten events): {g}");
    assert_no_secret(&g, &[&secret]);
}

#[tokio::test]
async fn a_new_code_replaces_the_unfinished_one() {
    let dir = TempDir::new("zlink-replace");
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    let zurl = "https://zbx.example.com";
    let first = begin(&c, &s, zurl).await;
    let second = begin(&c, &s, zurl).await;
    assert_ne!(first["secret"], second["secret"]);
    let b = pair_body(&first, zurl, "https://zbx.example.com/api_jsonrpc.php", now());
    let (st, _) = c.zabbix_pair(&b, &sign(first["secret"].as_str().unwrap(), &b), None);
    assert_eq!(st, 401, "the first code no longer pairs");
    let b = pair_body(&second, zurl, "https://zbx.example.com/api_jsonrpc.php", now());
    assert_eq!(c.zabbix_pair(&b, &sign(second["secret"].as_str().unwrap(), &b), None).0, 200);
}

#[tokio::test]
async fn re_pairing_keeps_the_old_secret_until_the_new_pairing_completes() {
    let dir = TempDir::new("zlink-repair");
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    let zurl = "https://zbx.example.com";
    let api = "https://zbx.example.com/api_jsonrpc.php";
    let one = begin(&c, &s, zurl).await;
    let a = one["secret"].as_str().unwrap().to_string();
    let b1 = pair_body(&one, zurl, api, now());
    assert_eq!(c.zabbix_pair(&b1, &sign(&a, &b1), None).0, 200);
    assert_eq!(sso_status(&c, &a), 200);

    let two = begin(&c, &s, zurl).await;
    let b = two["secret"].as_str().unwrap().to_string();
    assert_eq!(sso_status(&c, &a), 200, "sign-in keeps working while the new pairing is pending");
    assert_eq!(sso_status(&c, &b), 401, "the pending secret signs nobody in yet");

    let b2 = pair_body(&two, zurl, api, now());
    assert_eq!(c.zabbix_pair(&b2, &sign(&b, &b2), None).0, 200);
    assert_eq!(sso_status(&c, &b), 200);
    assert_eq!(sso_status(&c, &a), 401, "the old secret stops once the new one is in place");
}

#[tokio::test]
async fn allowed_sources_are_enforced_on_both_routes() {
    let dir = TempDir::new("zlink-sources");
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "allowedSources": ["10.1.0.0/16", "203.0.113.10"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let zurl = "https://zbx.example.com";
    let code = begin(&c, &s, zurl).await;
    let secret = code["secret"].as_str().unwrap().to_string();
    let body = pair_body(&code, zurl, "https://zbx.example.com/api_jsonrpc.php", now());
    let sig = sign(&secret, &body);
    let (st, out) = c.zabbix_pair(&body, &sig, Some("10.9.9.9".parse().unwrap()));
    assert_eq!((st, out["kind"].clone()), (403, json!("forbidden")));
    assert_eq!(c.zabbix_pair(&body, &sig, None).0, 403, "an unknown source is not an allowed one");
    // Refused by source, the body was never consumed: the same request from an allowed
    // address goes through.
    let (st, out) = c.zabbix_pair(&body, &sig, Some("10.1.200.3".parse().unwrap()));
    assert_eq!(st, 200, "{out}");

    let sb = sso_body("zed", 3);
    assert_eq!(c.zabbix_sso_init_from(&sb, &sign(&secret, &sb), Some("10.9.9.9".parse().unwrap())).0, 403);
    assert_eq!(c.zabbix_sso_init_from(&sb, &sign(&secret, &sb), Some("203.0.113.10".parse().unwrap())).0, 200);
}

#[test]
fn x_real_ip_is_believed_only_from_trusted_proxies() {
    let dir = TempDir::new("zlink-proxy");
    let c = core(&dir, ServerZbx { trusted_proxies: Some(vec!["172.18.0.0/16".into()]), ..Default::default() });
    let l = c.zabbix_link();
    let nginx = Some("172.18.0.5".parse().unwrap());
    let direct = Some("172.19.0.9".parse().unwrap());
    assert_eq!(l.effective_source(Some("203.0.113.7"), nginx), Some("203.0.113.7".parse().unwrap()));
    assert_eq!(l.effective_source(Some("203.0.113.7"), direct), direct, "a direct caller cannot claim an address");
    assert_eq!(l.effective_source(None, nginx), nginx);
    let open = core(&TempDir::new("zlink-proxy2"), ServerZbx::default());
    assert_eq!(open.zabbix_link().effective_source(Some("203.0.113.7"), direct), Some("203.0.113.7".parse().unwrap()),
               "without a trusted-proxy list, the header is believed (the X-Auth-User trust model)");
}

#[tokio::test]
async fn pairing_is_rate_limited_per_source() {
    let dir = TempDir::new("zlink-rate");
    let c = core(&dir, ServerZbx::default());
    let src = Some("10.2.3.4".parse().unwrap());
    let mut last = 0;
    for _ in 0..=PAIR_PER_MIN {
        last = c.zabbix_pair(b"{}", "00", src).0;
    }
    assert_eq!(last, 429);
    assert_eq!(c.zabbix_pair(b"{}", "00", Some("10.2.3.5".parse().unwrap())).0, 401, "another source has its own budget");
}

#[tokio::test]
async fn the_test_reports_an_untrusted_certificate_for_the_trust_flow() {
    let dir = TempDir::new("zlink-tls");
    let cert = support::tls::self_signed("localhost");
    let tls = support::tls::TlsServer::start(&cert).await;
    let c = core(&dir, ServerZbx::default());
    let s = admin(&c).await;
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "zabbixUrl": tls.url(), "apiToken": TOKEN })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let t = send(&c, &s, json!({ "type": "ZABBIX_LINK_TEST" })).await;
    assert_eq!(t["kind"], json!("tls_untrusted"), "{t}");
    let seen = t["cert"].clone();
    assert_eq!(seen["sha256"], json!(cert.sha256), "the certificate shown is the one presented: {t}");
    assert_eq!(seen["host"], json!(tls.host_key()));
    assert_eq!(tls.handshakes(), 0, "an untrusted certificate: no handshake completed, no token sent");
    // The existing trust decision is the one that fixes it.
    let tr = send(&c, &s, json!({ "type": "TRUST_CERT", "host": seen["host"], "sha256": seen["sha256"] })).await;
    assert_eq!(tr["ok"], json!(true), "{tr}");
    let t = send(&c, &s, json!({ "type": "ZABBIX_LINK_TEST" })).await;
    assert_ne!(t["kind"], json!("tls_untrusted"), "{t}");
    assert!(tls.handshakes() > 0, "the pinned certificate is accepted");
}
