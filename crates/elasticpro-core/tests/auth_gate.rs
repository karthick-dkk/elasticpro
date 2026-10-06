//! Accounts and roles, through the real message API rather than the module underneath it.
//!
//! `auth.rs` proves the rules in isolation; these prove they are actually reached. The gap
//! between "the matrix says no" and "the dispatch asks the matrix" is exactly where an
//! authorisation bug lives, so every case here goes through `Core::handle`.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";

fn core(dir: &TempDir, edition: Edition) -> std::sync::Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), edition, 1)
}

/// Sign in as the shipped account and get past its forced password change.
///
/// Every install now starts with one, so this is what "become an admin" looks like —
/// there is no empty state to bootstrap out of.
async fn admin_session(c: &std::sync::Arc<Core>) -> String {
    let res = c
        .handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(c) }))
        .await;
    assert_eq!(res["ok"], json!(true), "the shipped account should sign in: {res}");
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c
        .handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": PASSWORD }))
        .await;
    assert_eq!(ch["ok"], json!(true), "the forced change should succeed: {ch}");
    s
}

/// The name admin_session() leaves you signed in as.
const ADMIN: &str = "elasticpro";

async fn login(c: &std::sync::Arc<Core>, name: &str) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    assert_eq!(res["ok"], json!(true), "login failed for {name}: {res}");
    res["session"].as_str().expect("a session").to_string()
}

async fn add(c: &std::sync::Arc<Core>, admin: &str, name: &str, role: &str) -> Value {
    c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role }))
        .await
}

/* --------------------------------- portable --------------------------------- */

#[tokio::test]
async fn portable_never_asks_anyone_to_log_in() {
    let dir = TempDir::new("auth-portable");
    let c = core(&dir, Edition::Portable);

    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["authRequired"], json!(false));
    assert_eq!(ping["needsBootstrap"], json!(false));

    // Admin-only message types are open, because there are no roles at all.
    for t in ["CONFIG_READ", "PINS", "REQUEST_STATS"] {
        let res = c.handle(json!({ "type": t, "path": "" })).await;
        assert_ne!(res["kind"], json!("unauthenticated"), "{t} must not need a session in portable");
        assert_ne!(res["kind"], json!("forbidden"), "{t} must not be gated in portable");
        assert_ne!(res["kind"], json!("needs_bootstrap"), "{t} must not want a bootstrap in portable");
    }
}

#[tokio::test]
async fn portable_writes_no_accounts_file() {
    let dir = TempDir::new("auth-noaccounts");
    let c = core(&dir, Edition::Portable);
    let _ = c.handle(json!({ "type": "PING" })).await;
    assert!(
        !dir.0.join("users.json").exists(),
        "portable must not create an accounts file"
    );
}

/* -------------------------------- bootstrap --------------------------------- */

#[tokio::test]
async fn bootstrap_is_only_available_while_there_are_no_accounts() {
    let dir = TempDir::new("auth-rebootstrap");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;

    // The obvious privilege escalation: call it again and get a second admin. It is
    // refused twice over — the session gate stops it before the handler is reached,
    // because BOOTSTRAP_ADMIN is not in the no-session list once accounts exist...
    let anon = c
        .handle(json!({ "type": "BOOTSTRAP_ADMIN", "name": "mallory", "password": PASSWORD }))
        .await;
    assert_eq!(anon["ok"], json!(false), "{anon}");
    assert_eq!(anon["kind"], json!("unauthenticated"), "{anon}");

    // ...and the handler refuses it too, so an admin session is no way in either.
    let with_admin = c
        .handle(json!({ "type": "BOOTSTRAP_ADMIN", "session": admin, "name": "mallory", "password": PASSWORD }))
        .await;
    assert_eq!(with_admin["ok"], json!(false), "{with_admin}");
    assert_eq!(with_admin["kind"], json!("forbidden"), "{with_admin}");

    // Either way, no second account exists.
    let listed = c.handle(json!({ "type": "USER_LIST", "session": admin })).await;
    assert_eq!(listed["users"].as_array().unwrap().len(), 1, "{listed}");
}

/// An unauthenticated PING names nothing.
///
/// It has to answer at all — the shell cannot know whether to show a sign-in screen until
/// it asks — so it is the one reply a stranger who can reach the port is guaranteed to
/// get. For a while it was the whole status object: the cluster list, the config path,
/// the data directory, per-cluster request rates, the jump hosts, and the shipped
/// username together with whether its password still worked. None of that is needed to
/// draw a login box.
#[tokio::test]
async fn an_unauthenticated_ping_names_nothing() {
    let dir = TempDir::new("ping-leak");
    let c = core(&dir, Edition::Hosted);

    // Configured, so there is something to leak.
    let admin = admin_session(&c).await;
    let primed = c
        .handle(json!({
            "type": "PRIME", "session": admin,
            "clusters": [{ "id": "prod-1", "url": "http://127.0.0.1:9200" }],
        }))
        .await;
    assert_eq!(primed["ok"], json!(true), "{primed}");

    let anon = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(anon["ok"], json!(true), "the handshake still has to work: {anon}");
    assert_eq!(anon["authRequired"], json!(true), "{anon}");
    for named in [
        "clusters",
        "dataDir",
        "configHint",
        "defaultConfigPath",
        "requests",
        "tunnels",
        "uptimeSec",
        "primed",
        "readOnly",
        "writesUnlocked",
        "defaultUser",
        "defaultPasswordUnchanged",
    ] {
        assert!(anon.get(named).is_none(), "unauthenticated PING leaked `{named}`: {anon}");
    }

    // WHOAMI is the other pre-auth reply, and must not name the shipped account either.
    let who = c.handle(json!({ "type": "WHOAMI" })).await;
    assert!(who.get("defaultUser").is_none(), "WHOAMI named the shipped user: {who}");
    assert!(
        who.get("defaultPasswordUnchanged").is_none(),
        "WHOAMI said whether the shipped password still works: {who}"
    );

    // Signed in, the same call answers in full — the split is about the caller, not about
    // removing the figures the app runs on.
    let full = c.handle(json!({ "type": "PING", "session": admin })).await;
    assert_eq!(full["clusters"], json!(["prod-1"]), "{full}");
    assert!(full.get("dataDir").is_some(), "{full}");
    assert!(full.get("requests").is_some(), "{full}");
}

/* --------------------------- the account that ships ---------------------------- */

#[tokio::test]
async fn a_fresh_install_ships_an_account_that_can_do_nothing_but_change_itself() {
    let dir = TempDir::new("auth-seed");
    let c = core(&dir, Edition::Installed);

    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["authRequired"], json!(true));

    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(&c) })).await;
    assert_eq!(res["ok"], json!(true), "the shipped account should sign in: {res}");
    let s = res["session"].as_str().unwrap().to_string();
    assert_eq!(res["caller"]["mustChange"], json!(true), "{res}");

    // A known password is only acceptable because it buys nothing.
    for t in ["PINS", "CONFIG_READ", "USER_LIST", "WRITE_UNLOCK", "TOKEN_LIST"] {
        let r = c.handle(json!({ "type": t, "session": s })).await;
        assert_eq!(r["kind"], json!("must_change_password"), "{t} worked on the shipped password: {r}");
    }
    let es = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cluster/health" }))
        .await;
    assert_eq!(es["kind"], json!("must_change_password"), "not even a read: {es}");

    // Nor can it dodge the change by setting somebody else's password.
    let dodge = c
        .handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "someone", "password": "a-long-enough-one" }))
        .await;
    assert_eq!(dodge["ok"], json!(false), "{dodge}");

    // The replacement still has to be a real password.
    let short = c
        .handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": "abc" }))
        .await;
    assert_eq!(short["ok"], json!(false));
    assert!(short["message"].as_str().unwrap().contains("at least"), "{short}");

    // And once it is changed, the session in hand works — without signing in again.
    let ok = c
        .handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": PASSWORD }))
        .await;
    assert_eq!(ok["ok"], json!(true), "{ok}");
    assert_eq!(
        c.handle(json!({ "type": "USER_LIST", "session": s })).await["ok"],
        json!(true),
        "the live session should stop being locked the moment the password changes"
    );
}

#[tokio::test]
async fn the_shipped_password_stops_working_once_it_is_replaced() {
    let dir = TempDir::new("auth-seed-gone");
    let c = core(&dir, Edition::Installed);
    let first = support::first_password(&c);
    admin_session(&c).await;

    let old = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": first })).await;
    assert_eq!(old["ok"], json!(false), "the first password must not survive the change: {old}");
    let new = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": PASSWORD })).await;
    assert_eq!(new["ok"], json!(true));
    assert_eq!(new["caller"]["mustChange"], json!(false));
}

/* ------------------------- the first password, per install ------------------------ */

#[tokio::test]
async fn a_fresh_install_does_not_open_with_the_old_shipped_password() {
    for edition in [Edition::Hosted, Edition::Installed] {
        let dir = TempDir::new("auth-no-loginme");
        let c = core(&dir, edition);
        let r = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": "loginme" })).await;
        assert_eq!(r["ok"], json!(false), "{edition:?}: loginme opened a fresh install: {r}");
    }
}

#[tokio::test]
async fn two_installs_get_different_first_passwords() {
    let (d1, d2) = (TempDir::new("auth-pw-a"), TempDir::new("auth-pw-b"));
    let (c1, c2) = (core(&d1, Edition::Hosted), core(&d2, Edition::Hosted));
    let (p1, p2) = (support::first_password(&c1), support::first_password(&c2));
    assert_ne!(p1, p2);
    assert!(p1.chars().count() >= 20, "too short to be a first password");
    // Each opens its own install and not the other.
    let other = c1.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": p2 })).await;
    assert_eq!(other["ok"], json!(false));
}

#[tokio::test]
async fn the_first_password_file_is_owner_only_and_goes_after_the_change() {
    let dir = TempDir::new("auth-pw-file");
    let c = core(&dir, Edition::Hosted);
    let file = dir.join(elasticpro_core::auth::INITIAL_PASSWORD_FILE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).expect("the file").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode {mode:o}");
    }
    let pw = support::first_password(&c);
    // Nothing on disk holds it in the clear but that file.
    let users = std::fs::read_to_string(dir.join("users.json")).unwrap();
    assert!(!users.contains(&pw), "the password must not be in the accounts file");

    // A second start neither regenerates it nor removes it: it is still the live one.
    drop(c);
    let c = core(&dir, Edition::Hosted);
    assert_eq!(support::first_password(&c), pw);

    // A failed change leaves it where it is.
    let s = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": pw })).await;
    let s = s["session"].as_str().expect("a session").to_string();
    let short = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": "abc" })).await;
    assert_eq!(short["ok"], json!(false));
    assert!(file.exists());

    let ok = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": PASSWORD })).await;
    assert_eq!(ok["ok"], json!(true), "{ok}");
    assert!(!file.exists(), "the file must go once the password is changed");

    // And a later start does not bring it back.
    drop(c);
    let _c = core(&dir, Edition::Hosted);
    assert!(!file.exists());
}

#[tokio::test]
async fn an_existing_accounts_file_is_left_alone() {
    let dir = TempDir::new("auth-pw-existing");
    let c = core(&dir, Edition::Hosted);
    admin_session(&c).await;
    let before = std::fs::read_to_string(dir.join("users.json")).unwrap();
    drop(c);
    let _c = core(&dir, Edition::Hosted);
    assert_eq!(std::fs::read_to_string(dir.join("users.json")).unwrap(), before);
    assert!(!dir.join(elasticpro_core::auth::INITIAL_PASSWORD_FILE).exists());
}

#[tokio::test]
async fn portable_gets_no_seeded_account() {
    let dir = TempDir::new("auth-seed-portable");
    let c = core(&dir, Edition::Portable);
    let _ = c.handle(json!({ "type": "PING" })).await;
    assert!(!dir.0.join("users.json").exists(), "portable must not create an accounts file");
    assert!(!dir.join(elasticpro_core::auth::INITIAL_PASSWORD_FILE).exists(), "nor a first password");
    assert_eq!(c.handle(json!({ "type": "PING" })).await["authRequired"], json!(false));
}

#[tokio::test]
async fn no_session_means_nothing_but_the_public_messages() {
    let dir = TempDir::new("auth-nosession");
    let c = core(&dir, Edition::Installed);
    admin_session(&c).await;

    for t in ["CONFIG_READ", "WRITE_UNLOCK", "PINS", "USER_LIST"] {
        let res = c.handle(json!({ "type": t })).await;
        assert_eq!(res["kind"], json!("unauthenticated"), "{t} leaked without a session: {res}");
    }
    // PING still answers, or the UI could never discover it needs to log in.
    assert_eq!(c.handle(json!({ "type": "PING" })).await["ok"], json!(true));
}

#[tokio::test]
async fn a_bad_password_says_nothing_about_which_half_was_wrong() {
    let dir = TempDir::new("auth-badpw");
    let c = core(&dir, Edition::Installed);
    admin_session(&c).await;

    let wrong_pw = c.handle(json!({ "type": "LOGIN", "name": ADMIN, "password": "nope" })).await;
    let no_user = c.handle(json!({ "type": "LOGIN", "name": "ghost", "password": "nope" })).await;
    assert_eq!(wrong_pw["ok"], json!(false));
    assert_eq!(no_user["ok"], json!(false));
    assert_eq!(
        wrong_pw["message"], no_user["message"],
        "a wrong password and a missing account must be indistinguishable"
    );
}

#[tokio::test]
async fn logging_out_ends_the_session() {
    let dir = TempDir::new("auth-logout");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;
    assert_eq!(c.handle(json!({ "type": "USER_LIST", "session": s })).await["ok"], json!(true));
    c.handle(json!({ "type": "LOGOUT", "session": s })).await;
    assert_eq!(
        c.handle(json!({ "type": "USER_LIST", "session": s })).await["kind"],
        json!("unauthenticated")
    );
}

/* ------------------------------------ roles ----------------------------------- */

#[tokio::test]
async fn a_user_can_read_a_cluster_but_not_write_or_administer() {
    let dir = TempDir::new("auth-user");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    assert_eq!(add(&c, &admin, "reader", "user").await["ok"], json!(true));
    let s = login(&c, "reader").await;

    // Reads reach the cluster layer — "not primed" is the transport talking, which means
    // authorisation let it through.
    let read = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cat/indices" }))
        .await;
    assert_ne!(read["kind"], json!("forbidden"), "a user must be able to read indices: {read}");

    for (method, path) in [("DELETE", "/logstash-2026.01.01"), ("PUT", "/idx"), ("POST", "/idx/_doc")] {
        let res = c
            .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": method, "path": path }))
            .await;
        assert_eq!(res["kind"], json!("forbidden"), "{method} {path} must be refused for a user: {res}");
    }
    for t in ["WRITE_UNLOCK", "CONFIG_READ", "CONFIG_WRITE", "USER_LIST", "TRUST_CERT", "VAULT_GET", "PRIME"] {
        let res = c.handle(json!({ "type": t, "session": s })).await;
        assert_eq!(res["kind"], json!("forbidden"), "{t} must be refused for a user: {res}");
    }
}

#[tokio::test]
async fn a_guest_sees_health_and_no_index_names() {
    let dir = TempDir::new("auth-guest");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    assert_eq!(add(&c, &admin, "visitor", "guest").await["ok"], json!(true));
    let s = login(&c, "visitor").await;

    for p in ["/_cluster/health", "/_cat/nodes", "/_nodes/stats/fs"] {
        let res = c
            .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": p }))
            .await;
        assert_ne!(res["kind"], json!("forbidden"), "a guest should see {p}: {res}");
    }
    for p in ["/_cat/indices", "/_snapshot/repo/_all", "/logstash-*/_search", "/_ilm/explain"] {
        let res = c
            .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": p }))
            .await;
        assert_eq!(res["kind"], json!("forbidden"), "a guest must not see {p}: {res}");
    }
    // Nor the pages that name hosts and jump hosts.
    for t in ["TUNNELS", "PINS", "REQUEST_STATS"] {
        assert_eq!(
            c.handle(json!({ "type": t, "session": s })).await["kind"],
            json!("forbidden"),
            "{t} must be refused for a guest"
        );
    }
}

#[tokio::test]
async fn an_admin_can_do_the_things_the_others_cannot() {
    let dir = TempDir::new("auth-admin");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;

    for t in ["USER_LIST", "PINS", "REQUEST_STATS", "TUNNELS"] {
        let res = c.handle(json!({ "type": t, "session": s })).await;
        assert_eq!(res["ok"], json!(true), "{t} should work for an admin: {res}");
    }
    let unlock = c.handle(json!({ "type": "WRITE_UNLOCK", "session": s, "on": true })).await;
    assert_ne!(unlock["kind"], json!("forbidden"));
}

/* ------------------------------ account management ----------------------------- */

#[tokio::test]
async fn an_admin_cannot_lock_everyone_out() {
    let dir = TempDir::new("auth-lastadmin");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;

    let demote = c
        .handle(json!({ "type": "USER_SET_ROLE", "session": s, "name": ADMIN, "role": "user" }))
        .await;
    assert_eq!(demote["ok"], json!(false), "the only admin must not be able to demote themselves");

    let remove = c.handle(json!({ "type": "USER_REMOVE", "session": s, "name": ADMIN })).await;
    assert_eq!(remove["ok"], json!(false), "nor remove themselves");
}

#[tokio::test]
async fn changing_someones_role_ends_their_session_at_once() {
    let dir = TempDir::new("auth-demote");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    add(&c, &admin, "reader", "user").await;
    let s = login(&c, "reader").await;

    // Live before, gone after — a demotion that waits for a logout is not a demotion.
    let before = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cat/indices" }))
        .await;
    assert_ne!(before["kind"], json!("forbidden"));

    c.handle(json!({ "type": "USER_SET_ROLE", "session": admin, "name": "reader", "role": "guest" })).await;
    let after = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cat/indices" }))
        .await;
    assert_eq!(after["kind"], json!("unauthenticated"), "the old session must not survive: {after}");
}

#[tokio::test]
async fn accounts_and_roles_survive_a_restart() {
    let dir = TempDir::new("auth-restart");
    {
        let c = core(&dir, Edition::Installed);
        let admin = admin_session(&c).await;
        add(&c, &admin, "reader", "user").await;
    }
    // A fresh Core over the same data dir: same accounts, no bootstrap, sessions gone.
    let c2 = core(&dir, Edition::Installed);
    assert_eq!(c2.handle(json!({ "type": "PING" })).await["needsBootstrap"], json!(false));
    let s = login(&c2, "reader").await;
    let who = c2.handle(json!({ "type": "WHOAMI", "session": s })).await;
    assert_eq!(who["caller"]["role"], json!("user"));
}

#[tokio::test]
async fn the_accounts_file_never_holds_a_password() {
    let dir = TempDir::new("auth-nopw");
    let c = core(&dir, Edition::Installed);
    admin_session(&c).await;
    let raw = std::fs::read_to_string(dir.0.join("users.json")).expect("accounts file");
    assert!(!raw.contains(PASSWORD), "the password is in users.json: {raw}");
}

/* ---------------------------- hosted, and its upgrade --------------------------- */

#[tokio::test]
async fn a_disabled_account_is_not_let_in_by_the_proxy_either() {
    let dir = TempDir::new("auth-hosted-disabled");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    add(&c, &admin, "reader", "user").await;
    assert!(c.caller_for_proxy_user("reader").is_some());

    c.handle(json!({ "type": "USER_SET_ROLE", "session": admin, "name": "reader", "role": "guest" })).await;
    assert_eq!(
        c.caller_for_proxy_user("reader").expect("still an account").role,
        elasticpro_core::auth::Role::Guest,
        "the proxy path must read the current role, not a cached one"
    );
}

/* -------------------------------- api tokens --------------------------------- */

#[tokio::test]
async fn the_desktop_build_says_why_it_has_no_api_tokens() {
    let dir = TempDir::new("auth-notokens");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;
    let res = c.handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "zabbix", "role": "guest" })).await;
    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("unsupported"));
    assert!(res["message"].as_str().unwrap().contains("hosted"), "{res}");
}

#[tokio::test]
async fn a_hosted_token_works_and_carries_its_role() {
    let dir = TempDir::new("auth-tokens");
    let c = core(&dir, Edition::Hosted);
    let s = admin_session(&c).await;

    let made = c
        .handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "zabbix", "role": "guest" }))
        .await;
    assert_eq!(made["ok"], json!(true), "{made}");
    let secret = made["secret"].as_str().expect("a secret").to_string();
    assert!(secret.starts_with("elasticpro_"));

    // The token resolves to a caller, and that caller is bound by its role like anyone.
    let caller = c.caller_for_token(&secret).expect("the token should resolve");
    let health = c
        .handle_as(
            json!({ "type": "ES", "clusterId": "x", "method": "GET", "path": "/_cluster/health" }),
            Some(caller.clone()),
        )
        .await;
    assert_ne!(health["kind"], json!("forbidden"));
    let indices = c
        .handle_as(
            json!({ "type": "ES", "clusterId": "x", "method": "GET", "path": "/_cat/indices" }),
            Some(caller),
        )
        .await;
    assert_eq!(indices["kind"], json!("forbidden"), "a guest token must stay a guest: {indices}");

    // Revoked means revoked.
    let id = made["tokens"][0]["id"].as_str().unwrap().to_string();
    c.handle(json!({ "type": "TOKEN_REVOKE", "session": s, "id": id })).await;
    assert!(c.caller_for_token(&secret).is_none(), "a revoked token must stop resolving");
}

#[tokio::test]
async fn an_api_token_can_never_be_an_admin() {
    let dir = TempDir::new("auth-adm-token");
    let c = core(&dir, Edition::Hosted);
    let s = admin_session(&c).await;
    let res = c
        .handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "everything", "role": "admin" }))
        .await;
    assert_eq!(res["ok"], json!(false), "an admin token would be an unattended index deleter: {res}");
}

#[tokio::test]
async fn the_token_secret_is_shown_once_and_not_stored() {
    let dir = TempDir::new("auth-tok-once");
    let c = core(&dir, Edition::Hosted);
    let s = admin_session(&c).await;
    let made = c.handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "zabbix", "role": "user" })).await;
    let secret = made["secret"].as_str().unwrap().to_string();

    let listed = c.handle(json!({ "type": "TOKEN_LIST", "session": s })).await;
    assert!(!listed.to_string().contains(&secret), "listing must not repeat the secret");
    let raw = std::fs::read_to_string(dir.0.join("tokens.json")).expect("tokens file");
    assert!(!raw.contains(&secret), "the secret must not be on disk");
}

/* --------------------------- uploads and config history -------------------------- */

const A_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nc29tZXRoaW5n\n-----END OPENSSH PRIVATE KEY-----\n";

#[tokio::test]
async fn only_an_admin_uploads_a_private_key() {
    let dir = TempDir::new("auth-keys");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    add(&c, &admin, "reader", "user").await;
    let reader = login(&c, "reader").await;

    for s in [&reader] {
        let res = c.handle(json!({ "type": "KEY_UPLOAD", "session": s, "name": "id_ed25519", "text": A_KEY })).await;
        assert_eq!(res["kind"], json!("forbidden"), "a read-only user uploaded a key: {res}");
    }
    let res = c.handle(json!({ "type": "KEY_LIST", "session": reader })).await;
    assert_eq!(res["kind"], json!("forbidden"), "and cannot even see which keys exist");

    let up = c.handle(json!({ "type": "KEY_UPLOAD", "session": admin, "name": "id_ed25519", "text": A_KEY })).await;
    assert_eq!(up["ok"], json!(true), "{up}");
    // The path is what goes into a jump host's keyFile, so it has to come back.
    assert!(up["key"]["path"].as_str().unwrap().ends_with("id_ed25519"));
    // The key itself must not.
    assert!(!up.to_string().contains("c29tZXRoaW5n"), "the key material came back out");
}

#[tokio::test]
async fn saving_a_config_keeps_the_one_it_replaced() {
    let dir = TempDir::new("auth-history");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    let path = dir.0.join("config_cluster.json");

    let first = c.handle(json!({ "type": "CONFIG_WRITE", "session": admin, "path": path, "text": "{\"v\":1}" })).await;
    assert_eq!(first["ok"], json!(true));
    assert_eq!(first["keptVersion"], json!(false), "nothing existed to keep yet");

    let second = c.handle(json!({ "type": "CONFIG_WRITE", "session": admin, "path": path, "text": "{\"v\":2}" })).await;
    assert_eq!(second["keptVersion"], json!(true), "the first version should have been kept: {second}");

    let hist = c.handle(json!({ "type": "CONFIG_HISTORY", "session": admin })).await;
    let versions = hist["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 1, "{hist}");

    let id = versions[0]["id"].as_str().unwrap();
    let back = c.handle(json!({ "type": "CONFIG_RESTORE", "session": admin, "id": id })).await;
    assert_eq!(back["text"], json!("{\"v\":1}"), "restoring should hand back the older text: {back}");

    // A history of files that have held cluster credentials is admin-only too.
    add(&c, &admin, "reader", "user").await;
    let reader = login(&c, "reader").await;
    assert_eq!(
        c.handle(json!({ "type": "CONFIG_HISTORY", "session": reader })).await["kind"],
        json!("forbidden")
    );
}

#[tokio::test]
async fn portable_says_it_has_no_accounts_rather_than_none() {
    // "No users" and "no such thing as users here" are different answers, and only one
    // of them is true on a build with no accounts. An empty list would read as a fact
    // about the deployment — nobody has access — when it is a fact about the build.
    let dir = TempDir::new("auth-portable-users");
    let c = core(&dir, Edition::Portable);
    for t in ["USER_LIST", "USER_ADD", "USER_REMOVE", "USER_SET_ROLE", "USER_SET_PASSWORD"] {
        let res = c.handle(json!({ "type": t, "name": "someone", "role": "admin" })).await;
        assert_eq!(res["ok"], json!(false), "{t}: {res}");
        assert_eq!(res["supported"], json!(false), "{t}: {res}");
        assert!(res["users"].is_null(), "{t} must not hand back a list of accounts: {res}");
    }
    // And it is still not asking anyone to log in — the refusal is about the edition,
    // not about who is asking.
    let res = c.handle(json!({ "type": "USER_LIST" })).await;
    assert_ne!(res["kind"], json!("unauthenticated"), "{res}");
}

#[tokio::test]
async fn an_edition_with_accounts_still_lists_them() {
    let dir = TempDir::new("auth-installed-users");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;
    let res = c.handle(json!({ "type": "USER_LIST", "session": s })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert!(res["users"].as_array().is_some_and(|u| !u.is_empty()), "{res}");
}
