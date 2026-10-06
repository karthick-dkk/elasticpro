//! Signing in from Zabbix, through the real message API.
//!
//! `zbx_sso.rs` proves the signature, the clock and the codes in isolation. These prove the
//! mapping lands where it was agreed: a Zabbix User reaches only their clusters, a Zabbix
//! Admin reaches all of them and may write, a Super admin administers — and nobody below
//! admin can aim a cluster's credential somewhere else.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{TempDir, TestServer};

const SECRET: &str = "integration-secret-0123456789abcdef-xyz";

fn hosted(dir: &TempDir) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();
    c
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn nonce() -> String {
    format!("n-{}-{}", now(), rand_suffix())
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

/// Zabbix's half: sign a claim and post it.
fn init(c: &Arc<Core>, user: &str, ty: i64, groups: &[&str]) -> (u16, Value) {
    let body = serde_json::to_vec(&json!({
        "username": user, "zabbix_user_type": ty, "groups": groups, "ts": now(), "nonce": nonce(),
    }))
    .unwrap();
    c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body))
}

/// The browser's half: spend the code.
async fn session_for(c: &Arc<Core>, user: &str, ty: i64, groups: &[&str]) -> (String, Value) {
    let (status, out) = init(c, user, ty, groups);
    assert_eq!(status, 200, "sign-in refused: {out}");
    let code = out["sso_code"].as_str().unwrap().to_string();
    let res = c.handle(json!({ "type": "SSO_EXCHANGE", "code": code })).await;
    assert_eq!(res["ok"], json!(true), "exchange failed: {res}");
    (res["session"].as_str().unwrap().to_string(), res["caller"].clone())
}

/// An admin session, past the shipped password.
async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(c) })).await;
    let s = res["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro",
                              "password": "correct-horse-battery" })).await;
    assert_eq!(ch["ok"], json!(true));
    s
}

/// Two clusters on two test servers: `alpha` for the "ES alpha" group, `beta` for "ES beta".
async fn primed(c: &Arc<Core>) -> (TestServer, TestServer) {
    let a = TestServer::start().await;
    let b = TestServer::start().await;
    let s = admin(c).await;
    let res = c.handle(json!({ "type": "PRIME", "session": s, "readOnly": false, "clusters": [
        { "id": "alpha", "url": a.url(), "authHeader": "Basic YWxwaGE6c2VjcmV0", "zabbixGroups": ["ES alpha"] },
        { "id": "beta",  "url": b.url(), "authHeader": "Basic YmV0YTpzZWNyZXQ=",  "zabbixGroups": ["ES beta"] },
    ]})).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    (a, b)
}

async fn get(c: &Arc<Core>, session: &str, cluster: &str, url: &str) -> Value {
    c.handle(json!({ "type": "ES", "session": session, "clusterId": cluster, "url": url,
                     "method": "GET", "path": "/_cluster/health" })).await
}

/* ---------------------------------- the mapping ---------------------------------- */

#[tokio::test]
async fn zabbix_user_types_become_the_agreed_roles() {
    let dir = TempDir::new("zbx-roles");
    let c = hosted(&dir);
    let (_, u) = session_for(&c, "uma", 1, &["ES alpha"]).await;
    let (_, a) = session_for(&c, "adam", 2, &[]).await;
    let (_, s) = session_for(&c, "sara", 3, &[]).await;
    assert_eq!((u["role"].clone(), u["scoped"].clone()), (json!("user"), json!(true)));
    assert_eq!((a["role"].clone(), a["scoped"].clone()), (json!("operator"), json!(false)));
    assert_eq!((s["role"].clone(), s["scoped"].clone()), (json!("admin"), json!(false)));
    assert_eq!(u["name"], json!("uma@zabbix"), "names are namespaced");
}

#[tokio::test]
async fn a_zabbix_user_reaches_only_their_clusters() {
    let dir = TempDir::new("zbx-scope");
    let c = hosted(&dir);
    let (a, b) = primed(&c).await;
    let (s, _) = session_for(&c, "uma", 1, &["ES alpha"]).await;

    let ok = get(&c, &s, "alpha", &a.url()).await;
    assert_eq!(ok["ok"], json!(true), "their own cluster: {ok}");

    let no = get(&c, &s, "beta", &b.url()).await;
    assert_eq!(no["kind"], json!("forbidden"), "someone else's cluster: {no}");
    assert_eq!(b.connections(), 0, "nothing may reach a cluster the caller cannot see");

    // And it is invisible, not merely refused.
    let ping = c.handle(json!({ "type": "PING", "session": s })).await;
    assert_eq!(ping["clusters"], json!(["alpha"]));
    assert!(ping["configHint"].is_null() && ping["dataDir"].is_null(), "server paths are an admin's business");
}

#[tokio::test]
async fn a_zabbix_user_in_no_mapped_group_sees_nothing() {
    let dir = TempDir::new("zbx-nogroup");
    let c = hosted(&dir);
    let (a, _) = primed(&c).await;
    let (s, _) = session_for(&c, "nobody", 1, &["Unrelated group"]).await;
    let res = get(&c, &s, "alpha", &a.url()).await;
    assert_eq!(res["kind"], json!("forbidden"), "the default for someone Zabbix has not placed is no clusters");
    let ping = c.handle(json!({ "type": "PING", "session": s })).await;
    assert_eq!(ping["clusters"], json!([]));
}

#[tokio::test]
async fn group_changes_in_zabbix_apply_at_the_next_sign_in() {
    let dir = TempDir::new("zbx-regroup");
    let c = hosted(&dir);
    let (a, b) = primed(&c).await;
    let (old, _) = session_for(&c, "uma", 1, &["ES alpha"]).await;
    // Moved to beta in Zabbix, and opens the page again.
    let (new, _) = session_for(&c, "uma", 1, &["ES beta"]).await;
    assert_eq!(get(&c, &new, "beta", &b.url()).await["ok"], json!(true));
    assert_eq!(get(&c, &new, "alpha", &a.url()).await["kind"], json!("forbidden"));
    // The tab already open changes with it rather than keeping the old grant.
    assert_eq!(get(&c, &old, "alpha", &a.url()).await["kind"], json!("forbidden"));
}

#[tokio::test]
async fn a_zabbix_admin_sees_every_cluster_and_may_write_but_not_administer() {
    let dir = TempDir::new("zbx-operator");
    let c = hosted(&dir);
    let (a, b) = primed(&c).await;
    let (s, _) = session_for(&c, "adam", 2, &[]).await;
    assert_eq!(get(&c, &s, "alpha", &a.url()).await["ok"], json!(true));
    assert_eq!(get(&c, &s, "beta", &b.url()).await["ok"], json!(true));

    // Managing: the write guard is theirs to unlock, and a write then goes through.
    let un = c.handle(json!({ "type": "WRITE_UNLOCK", "session": s, "on": true })).await;
    assert_eq!(un["ok"], json!(true), "{un}");
    let del = c.handle(json!({ "type": "ES", "session": s, "clusterId": "alpha", "url": a.url(),
                                "method": "DELETE", "path": "/old-index", "allowWrites": true })).await;
    assert_eq!(del["ok"], json!(true), "an operator's write: {del}");
    assert_eq!(a.last_hit().unwrap().method, "DELETE");

    // Not administering.
    for t in ["CONFIG_READ", "USER_LIST", "TOKEN_CREATE", "KEY_LIST", "DELAY_SINK_SET", "TRUST_CERT"] {
        let r = c.handle(json!({ "type": t, "session": s, "path": "/etc/passwd" })).await;
        assert_eq!(r["kind"], json!("forbidden"), "{t} must be admin-only: {r}");
    }
}

#[tokio::test]
async fn a_zabbix_user_cannot_write_even_to_their_own_cluster() {
    let dir = TempDir::new("zbx-user-write");
    let c = hosted(&dir);
    let (a, _) = primed(&c).await;
    let (s, _) = session_for(&c, "uma", 1, &["ES alpha"]).await;
    let r = c.handle(json!({ "type": "ES", "session": s, "clusterId": "alpha", "url": a.url(),
                              "method": "DELETE", "path": "/x", "allowWrites": true })).await;
    assert_eq!(r["kind"], json!("forbidden"));
    assert_eq!(c.handle(json!({ "type": "WRITE_UNLOCK", "session": s, "on": true })).await["kind"], json!("forbidden"));
}

#[tokio::test]
async fn a_super_admin_administers() {
    let dir = TempDir::new("zbx-super");
    let c = hosted(&dir);
    let (s, _) = session_for(&c, "sara", 3, &[]).await;
    let r = c.handle(json!({ "type": "USER_LIST", "session": s })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let me = r["users"].as_array().unwrap().iter().find(|u| u["name"] == "sara@zabbix").unwrap().clone();
    assert_eq!(me["source"], json!("zabbix"), "the accounts page can tell where an account came from");
}

/* --------------------------- aiming a credential elsewhere --------------------------- */

#[tokio::test]
async fn nobody_below_admin_can_send_a_clusters_credential_elsewhere() {
    let dir = TempDir::new("zbx-redirect");
    let c = hosted(&dir);
    let (_, _) = primed(&c).await;
    let thief = TestServer::start().await;
    for (user, ty, groups) in [("uma", 1, vec!["ES alpha"]), ("adam", 2, vec![])] {
        let (s, _) = session_for(&c, user, ty, &groups).await;
        let r = get(&c, &s, "alpha", &thief.url()).await;
        assert_eq!(r["kind"], json!("forbidden"), "{user}: {r}");
        let r = c.handle(json!({ "type": "ES", "session": s, "clusterId": "alpha",
                                  "authHeader": "Basic eHg6eHg=", "method": "GET", "path": "/" })).await;
        assert_eq!(r["kind"], json!("forbidden"), "{user} supplying a credential: {r}");
    }
    assert_eq!(thief.connections(), 0, "the stored credential must never have left for another address");
}

#[tokio::test]
async fn an_admin_keeps_the_diagnostics() {
    let dir = TempDir::new("zbx-admin-probe");
    let c = hosted(&dir);
    let (_, _) = primed(&c).await;
    let other = TestServer::start().await;
    let (s, _) = session_for(&c, "sara", 3, &[]).await;
    let r = get(&c, &s, "alpha", &other.url()).await;
    assert_ne!(r["kind"], json!("forbidden"), "the connection diagnostics probe other URLs: {r}");
}

/* ------------------------------------ refusals ------------------------------------ */

#[tokio::test]
async fn a_local_account_is_never_taken_over() {
    let dir = TempDir::new("zbx-takeover");
    let c = hosted(&dir);
    let s = admin(&c).await;
    let add = c.handle(json!({ "type": "USER_ADD", "session": s, "name": "eve@zabbix",
                                "password": "correct-horse-battery", "role": "admin" })).await;
    assert_eq!(add["ok"], json!(true));
    let (status, out) = init(&c, "eve", 1, &[]);
    assert_eq!(status, 409, "{out}");
}

#[tokio::test]
async fn an_account_disabled_here_stays_out() {
    let dir = TempDir::new("zbx-disabled");
    let c = hosted(&dir);
    let _ = session_for(&c, "mallory", 2, &[]).await;
    // Disabled by an admin here. Written to the store directly: which page control does
    // it is not the point, the store being the authority is.
    let dir_users = std::fs::read_to_string(dir.join("users.json")).unwrap();
    let mut users: Value = serde_json::from_str(&dir_users).unwrap();
    for u in users.as_array_mut().unwrap() {
        if u["name"] == "mallory@zabbix" { u["disabled"] = json!(true); }
    }
    std::fs::write(dir.join("users.json"), users.to_string()).unwrap();
    let c2 = hosted(&dir);
    let (status, _) = init(&c2, "mallory", 2, &[]);
    assert_eq!(status, 403);
}

#[tokio::test]
async fn a_zabbix_account_has_no_password_here() {
    let dir = TempDir::new("zbx-nopass");
    let c = hosted(&dir);
    let _ = session_for(&c, "uma", 1, &[]).await;
    for pw in ["", "loginme", "correct-horse-battery"] {
        let r = c.handle(json!({ "type": "LOGIN", "name": "uma@zabbix", "password": pw })).await;
        assert_eq!(r["ok"], json!(false), "password {pw:?} opened a Zabbix account");
    }
    let s = admin(&c).await;
    let r = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "uma@zabbix",
                              "password": "correct-horse-battery" })).await;
    assert_eq!(r["ok"], json!(false), "setting one would make it a second way in: {r}");
}

#[tokio::test]
async fn an_account_marked_as_zabbixs_is_closed_to_passwords_even_one_that_matches() {
    // The random password makes this unreachable in normal use. It is reachable when the
    // accounts file is edited or migrated: an account that had a password here, now marked
    // as Zabbix's. Zabbix decides who that is; a password here must not be a second say.
    let dir = TempDir::new("zbx-marked");
    {
        let c = hosted(&dir);
        let s = admin(&c).await;
        let add = c.handle(json!({ "type": "USER_ADD", "session": s, "name": "bob",
                                    "password": "correct-horse-battery", "role": "user" })).await;
        assert_eq!(add["ok"], json!(true));
        assert_eq!(c.handle(json!({ "type": "LOGIN", "name": "bob", "password": "correct-horse-battery" })).await["ok"],
                   json!(true), "the password works while the account is local");
    }
    let text = std::fs::read_to_string(dir.join("users.json")).unwrap();
    let mut users: Value = serde_json::from_str(&text).unwrap();
    for u in users.as_array_mut().unwrap() {
        if u["name"] == "bob" { u["source"] = json!("zabbix"); }
    }
    std::fs::write(dir.join("users.json"), users.to_string()).unwrap();
    let c = hosted(&dir);
    let r = c.handle(json!({ "type": "LOGIN", "name": "bob", "password": "correct-horse-battery" })).await;
    assert_eq!(r["ok"], json!(false), "{r}");
}

#[tokio::test]
async fn a_code_works_once() {
    let dir = TempDir::new("zbx-code");
    let c = hosted(&dir);
    let (_, out) = init(&c, "uma", 1, &[]);
    let code = out["sso_code"].as_str().unwrap();
    assert_eq!(c.handle(json!({ "type": "SSO_EXCHANGE", "code": code })).await["ok"], json!(true));
    assert_eq!(c.handle(json!({ "type": "SSO_EXCHANGE", "code": code })).await["ok"], json!(false));
}

#[tokio::test]
async fn off_until_a_secret_is_set_and_never_outside_hosted() {
    let dir = TempDir::new("zbx-off");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let body = br#"{"username":"x","zabbix_user_type":3,"groups":[],"ts":0,"nonce":"0000000000000000"}"#;
    assert_eq!(c.zabbix_sso_init(body, "00").0, 503);
    let dir2 = TempDir::new("zbx-installed");
    let d = Core::new_with_rounds(Some(dir2.0.clone()), Edition::Installed, 1);
    d.zabbix_sso().set_secret(SECRET).unwrap();
    assert_eq!(d.zabbix_sso_init(body, &ZabbixSso::sign(SECRET.as_bytes(), body)).0, 404);
}

#[tokio::test]
async fn an_operator_api_token_is_refused() {
    // A token that can write is a token that can delete indices unattended.
    let dir = TempDir::new("zbx-token");
    let c = hosted(&dir);
    let s = admin(&c).await;
    let r = c.handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "t", "role": "operator" })).await;
    assert_eq!(r["ok"], json!(false), "{r}");
}

/* ---------------------------------- surviving a restart ---------------------------------- */

#[tokio::test]
async fn the_last_cluster_setup_survives_a_restart() {
    let dir = TempDir::new("zbx-restore");
    let a = TestServer::start().await;
    {
        let c = hosted(&dir);
        let s = admin(&c).await;
        c.handle(json!({ "type": "PRIME", "session": s, "clusters": [
            { "id": "alpha", "url": a.url(), "authHeader": "Basic YTpi", "zabbixGroups": ["ES alpha"] }]})).await;
    }
    let c = hosted(&dir);
    c.restore_prime().await;
    let (s, _) = session_for(&c, "uma", 1, &["ES alpha"]).await;
    assert_eq!(get(&c, &s, "alpha", &a.url()).await["ok"], json!(true), "no admin had to open the app first");
    assert_eq!(a.last_hit().unwrap().header("authorization"), Some("Basic YTpi"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("primed.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "it holds credentials");
    }
}

#[tokio::test]
async fn a_sealed_config_is_not_kept_on_disk() {
    let dir = TempDir::new("zbx-sealed");
    let c = hosted(&dir);
    let s = admin(&c).await;
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [{ "id": "x", "url": "http://127.0.0.1:1" }] })).await;
    assert!(dir.join("primed.json").exists());
    c.handle(json!({ "type": "PRIME", "session": s, "persist": false, "clusters": [{ "id": "x", "url": "http://127.0.0.1:1" }] })).await;
    assert!(!dir.join("primed.json").exists(), "unlocked secrets must not be written in the clear");
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [] })).await;
    c.handle(json!({ "type": "FORGET", "session": s })).await;
    assert!(!dir.join("primed.json").exists(), "forgetting forgets the copy on disk too");
}

/* ------------------------- a credential survives a reload ------------------------- */

async fn prime(c: &Arc<Core>, s: &str, cluster: Value) -> Value {
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [cluster] })).await
}

#[tokio::test]
async fn a_reprime_without_a_credential_keeps_the_one_held() {
    // Every Zabbix page load is a fresh app that re-reads a config holding no password.
    // Wiping the credential an admin typed on each of those was the reported bug.
    let dir = TempDir::new("zbx-keep");
    let a = TestServer::start().await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    prime(&c, &s, json!({ "id": "alpha", "url": a.url(), "authHeader": "Basic dHlwZWQ6aXQ=" })).await;
    let again = prime(&c, &s, json!({ "id": "alpha", "url": a.url(), "authHeader": null })).await;
    assert_eq!(again["held"], json!(["alpha"]), "the page is told the server has it: {again}");
    get(&c, &s, "alpha", &a.url()).await;
    assert_eq!(a.last_hit().unwrap().header("authorization"), Some("Basic dHlwZWQ6aXQ="));
    // And the copy on disk is the retained one, so a restart keeps it too.
    let disk = std::fs::read_to_string(dir.join("primed.json")).unwrap();
    assert!(disk.contains("Basic dHlwZWQ6aXQ="), "the persisted setup lost the credential");
}

#[tokio::test]
async fn a_new_url_never_inherits_a_credential() {
    let dir = TempDir::new("zbx-newurl");
    let a = TestServer::start().await;
    let b = TestServer::start().await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    prime(&c, &s, json!({ "id": "alpha", "url": a.url(), "authHeader": "Basic c2VjcmV0" })).await;
    let moved = prime(&c, &s, json!({ "id": "alpha", "url": b.url() })).await;
    assert_eq!(moved["held"], json!([]));
    get(&c, &s, "alpha", &b.url()).await;
    assert_eq!(b.last_hit().unwrap().header("authorization"), None,
               "a credential given for one address went to another");
}

#[tokio::test]
async fn an_explicit_empty_credential_clears_it() {
    // "Continue without credentials" and "forget the credential" send "" on purpose.
    let dir = TempDir::new("zbx-clear");
    let a = TestServer::start().await;
    let c = hosted(&dir);
    let s = admin(&c).await;
    prime(&c, &s, json!({ "id": "alpha", "url": a.url(), "authHeader": "Basic c2VjcmV0" })).await;
    let cleared = prime(&c, &s, json!({ "id": "alpha", "url": a.url(), "authHeader": "" })).await;
    assert_eq!(cleared["held"], json!([]));
    // And it stays cleared through the next credential-less reload.
    prime(&c, &s, json!({ "id": "alpha", "url": a.url() })).await;
    get(&c, &s, "alpha", &a.url()).await;
    assert_eq!(a.last_hit().unwrap().header("authorization"), None);
}

#[tokio::test]
async fn a_session_passphrase_is_never_written_to_disk() {
    let dir = TempDir::new("zbx-passphrase");
    let c = hosted(&dir);
    let s = admin(&c).await;
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [],
                     "jumpHosts": [{ "id": "j", "host": "127.0.0.1", "port": 1, "user": "u" }] })).await;
    c.handle(json!({ "type": "TUNNEL_SECRET", "session": s, "jumpId": "j", "passphrase": "hunter2-passphrase" })).await;
    c.handle(json!({ "type": "PRIME", "session": s, "clusters": [],
                     "jumpHosts": [{ "id": "j", "host": "127.0.0.1", "port": 1, "user": "u" }] })).await;
    let disk = std::fs::read_to_string(dir.join("primed.json")).unwrap();
    assert!(!disk.contains("hunter2"), "a jump-host passphrase reached the disk: {disk}");
}

/* --------------------- the fleet cache, seen from a Zabbix sign-in --------------------- */

#[tokio::test]
async fn a_zabbix_session_reads_the_fleet_cache_and_its_event_stream_for_its_clusters_only() {
    // Inside Zabbix the app reads FLEET_STATE and opens GET /events with a ticket, exactly as
    // it does on its own. The session behind both is the one SSO_EXCHANGE made — so the
    // Zabbix groups decide what the cache and the stream show, and a move between groups in
    // Zabbix reaches a stream that is already open, at its next re-check.
    let dir = TempDir::new("zbx-fleet");
    let c = hosted(&dir);
    let (_a, _b) = primed(&c).await;
    let (s, _) = session_for(&c, "uma", 1, &["ES alpha"]).await;

    let st = c.handle(json!({ "type": "FLEET_STATE", "session": s })).await;
    assert_eq!(st["ok"], json!(true), "{st}");
    assert_eq!(st["clusterIds"], json!(["alpha"]), "only the clusters Zabbix placed them on: {st}");

    let t = c.handle(json!({ "type": "EVENTS_TICKET", "session": s })).await;
    assert_eq!(t["ok"], json!(true), "{t}");
    let owner = c.redeem_events_ticket(t["ticket"].as_str().unwrap()).expect("a fresh ticket redeems");
    let who = c.events_revalidate(&owner).flatten().expect("the Zabbix session is somebody");
    assert_eq!(who.name, "uma@zabbix");

    let ev = |id: &str| elasticpro_core::fleet::events::FleetEvent { cluster_id: id.into(), dataset: None, payload: json!({}) };
    assert!(c.fleet_event_visible(Some(&who), &ev("alpha")));
    assert!(!c.fleet_event_visible(Some(&who), &ev("beta")), "another group's cluster is not announced");

    // Moved to beta in Zabbix and opened another Zabbix page: the open stream follows.
    session_for(&c, "uma", 1, &["ES beta"]).await;
    let now = c.events_revalidate(&owner).flatten().expect("still signed in");
    assert!(c.fleet_event_visible(Some(&now), &ev("beta")));
    assert!(!c.fleet_event_visible(Some(&now), &ev("alpha")));

    // Ended (the frame's session was signed out): the stream closes rather than carrying on.
    c.handle(json!({ "type": "LOGOUT", "session": s })).await;
    assert!(c.events_revalidate(&owner).is_none());
}

/* ------------------------------ notification history ------------------------------ */

#[tokio::test]
async fn a_scoped_callers_history_follows_their_clusters() {
    let dir = TempDir::new("zbx-notify-scope");
    let c = hosted(&dir);
    primed(&c).await;
    let list = |s: String| {
        let c = c.clone();
        async move {
            let r = c.handle(json!({ "type": "NOTIFY_LIST", "session": s })).await;
            assert_eq!(r["ok"], json!(true), "{r}");
            let mut m: Vec<String> =
                r["items"].as_array().unwrap().iter().map(|x| x["message"].as_str().unwrap().to_string()).collect();
            m.sort();
            m
        }
    };

    let (s, _) = session_for(&c, "uma", 1, &["ES alpha", "ES beta"]).await;
    for (msg, cluster) in [("about alpha", json!("alpha")), ("about beta", json!("beta")), ("about nothing", Value::Null)] {
        let r = c.handle(json!({ "type": "NOTIFY_PUT", "session": s, "message": msg, "kind": "ok", "cluster": cluster })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
    }
    assert_eq!(list(s.clone()).await, ["about alpha", "about beta", "about nothing"]);

    // Zabbix takes beta away: its notices go with it; the one about no cluster stays.
    let (now_s, _) = session_for(&c, "uma", 1, &["ES alpha"]).await;
    assert_eq!(list(now_s).await, ["about alpha", "about nothing"]);

    // An unscoped caller (Zabbix Admin) is not filtered — and still sees only their own.
    let (adam, _) = session_for(&c, "adam", 2, &[]).await;
    c.handle(json!({ "type": "NOTIFY_PUT", "session": adam, "message": "adam on beta", "kind": "ok", "cluster": "beta" })).await;
    assert_eq!(list(adam).await, ["adam on beta"]);
}
