//! ElasticPro roles from Zabbix user groups, and the per-person "No access" pin, end to end
//! (docs/ROLES.md): the group map in the server's config decides what a Zabbix sign-in
//! becomes, a role set by hand beats it, No access refuses the person everywhere, the last
//! administrator able to sign in is never locked out, and a site's older role-name map keeps
//! working until an admin saves a group map.
//!
//! Its own test binary because it needs `ELASTICPRO_CONFIG`, which is process-wide.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::TempDir;

const SECRET: &str = "zabbix-roles-secret-0123456789abcdef-xyz";

/// ELASTICPRO_CONFIG is one per process and each test sets its own: they take turns.
static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn nonce() -> String {
    format!("n-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
}

fn signed(c: &Arc<Core>, body: Value) -> (u16, Value) {
    let body = serde_json::to_vec(&body).unwrap();
    c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body))
}

/// What a 2.1.20 embed module posts: the role name and the user groups with their ids.
fn claim(user: &str, ty: i64, role: Option<&str>, groups: &[(&str, &str)]) -> Value {
    let mut c = json!({
        "username": user, "zabbix_user_type": ty,
        "groups": groups.iter().map(|(_, n)| *n).collect::<Vec<_>>(),
        "user_groups": groups.iter().map(|(id, n)| json!({ "id": id, "name": n })).collect::<Vec<_>>(),
        "ts": now(), "nonce": nonce(),
    });
    if let Some(r) = role {
        c["zabbix_role"] = json!(r);
    }
    c
}

/// Zabbix's half and the browser's: the mint's status and body, and a session when it was issued.
async fn sign_in(c: &Arc<Core>, user: &str, ty: i64, role: Option<&str>, groups: &[(&str, &str)]) -> (u16, Value, Option<String>) {
    let (status, out) = signed(c, claim(user, ty, role, groups));
    if status != 200 {
        return (status, out, None);
    }
    let res = c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await;
    assert_eq!(res["ok"], json!(true), "the code did not exchange: {res}");
    (status, out, Some(res["session"].as_str().expect("a session").to_string()))
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().unwrap().to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": "correct-horse-battery" })).await;
    assert_eq!(ch["ok"], json!(true));
    s
}

fn config(zabbix: Value) -> Value {
    json!({
        "version": 2,
        "clusters": [{ "name": "Alpha", "url": "https://alpha.example:9200", "apiKey": "alpha-api-key" }],
        "zabbix": zabbix,
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

fn file(path: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The group table the Config page draws: each ElasticPro role's Zabbix user groups.
fn group_map() -> Value {
    json!({ "groups": {
        "admin": [{ "id": "1", "name": "ElasticPro admins" }],
        "operator": [{ "id": "2", "name": "NOC leads" }],
        "user": [{ "id": "3", "name": "NOC" }, { "id": "4", "name": "Client A team" }],
        "guest": [{ "id": "5", "name": "Auditors" }] } })
}

async fn set_map(c: &Arc<Core>, s: &str, map: Value) -> Value {
    c.handle(json!({ "type": "ZABBIX_ROLEMAP_SET", "session": s, "roleMap": map })).await
}

fn user<'a>(list: &'a Value, account: &str) -> &'a Value {
    list["users"].as_array().unwrap().iter().find(|u| u["account"] == json!(account)).unwrap_or_else(|| panic!("no {account} in {list}"))
}

/* ------------------------------ the map at sign-in ------------------------------ */

#[tokio::test]
async fn a_person_in_several_mapped_groups_signs_in_with_the_highest_role() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-highest");
    let (c, _) = hosted(&dir, &config(json!({})));
    let a = admin(&c).await;
    let r = set_map(&c, &a, group_map()).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["groupMapSaved"], json!(true));

    // A Zabbix User (type 1) in NOC and NOC leads: operator, from NOC leads.
    let (_, out, s) = sign_in(&c, "a.kumar", 1, Some("User role"), &[("3", "NOC"), ("2", "NOC leads")]).await;
    assert_eq!((out["role"].clone(), out["source"].clone()), (json!("operator"), json!("group")), "{out}");
    let who = c.handle(json!({ "type": "WHOAMI", "session": s.unwrap() })).await;
    assert_eq!(who["caller"]["role"], json!("operator"));
    // A Zabbix Super admin (type 3) in only the Auditors group is a guest: the groups decide.
    let (_, out, _) = sign_in(&c, "auditor", 3, Some("Super admin role"), &[("5", "Auditors")]).await;
    assert_eq!(out["role"], json!("guest"), "{out}");
    // Membership changes apply at the next sign-in, to the open session too.
    let (_, out, s2) = sign_in(&c, "a.kumar", 1, Some("User role"), &[("3", "NOC")]).await;
    assert_eq!(out["role"], json!("user"), "{out}");
    assert_eq!(c.handle(json!({ "type": "WHOAMI", "session": s2.unwrap() })).await["caller"]["role"], json!("user"));
    // An older module sends only group names: matched by name all the same.
    let (status, out) = signed(&c, json!({ "username": "old.module", "zabbix_user_type": 1, "groups": ["NOC leads"], "ts": now(), "nonce": nonce() }));
    assert_eq!((status, out["role"].clone()), (200, json!("operator")), "{out}");
    // A renamed group is still known by its id.
    let (_, out, _) = sign_in(&c, "renamed", 1, None, &[("1", "ElasticPro administrators (renamed)")]).await;
    assert_eq!(out["role"], json!("admin"), "{out}");
}

#[tokio::test]
async fn in_no_mapped_group_the_fallback_rule_decides_and_can_be_no_access() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-unmapped");
    let (c, path) = hosted(&dir, &config(json!({})));
    let a = admin(&c).await;
    set_map(&c, &a, group_map()).await;
    // Today's rule: the Zabbix user type (Admin → operator).
    let (_, out, _) = sign_in(&c, "d.new", 2, Some("Admin role"), &[("9", "Zabbix users")]).await;
    assert_eq!((out["role"].clone(), out["source"].clone()), (json!("operator"), json!("zabbixRole")), "{out}");
    // The admin chooses no access for people in none of the groups.
    let r = set_map(&c, &a, json!({ "unmapped": "none" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(file(&path)["zabbix"]["roleMap"]["unmapped"], json!("none"));
    assert_eq!(file(&path)["zabbix"]["roleMap"]["groups"]["operator"], json!([{ "id": "2", "name": "NOC leads" }]), "the group table was kept");
    let (status, out, s) = sign_in(&c, "d.new", 2, Some("Admin role"), &[("9", "Zabbix users")]).await;
    assert_eq!((status, out["kind"].clone(), s), (403, json!("no_role"), None), "{out}");
    assert!(out["message"].as_str().unwrap().contains("\"Zabbix users\""), "the refusal names their groups: {out}");
    // Even a Super admin in no mapped group.
    let (status, _, _) = sign_in(&c, "super", 3, Some("Super admin role"), &[]).await;
    assert_eq!(status, 403);
    // A mapped group still gets in.
    let (status, out, _) = sign_in(&c, "n.shift", 1, None, &[("3", "NOC")]).await;
    assert_eq!((status, out["role"].clone()), (200, json!("user")), "{out}");
    // The refused person's groups were still recorded for the table (they had signed in before).
    let list = c.handle(json!({ "type": "ZABBIX_USERS", "session": a })).await;
    let d = user(&list, "d.new@zabbix");
    assert_eq!((d["fromGroups"]["role"].clone(), d["fromGroups"]["source"].clone()), (Value::Null, json!("unmapped")), "{d}");
    assert_eq!(d["inForce"], json!("operator"), "what they held from the sign-in before; the next one is refused");
    assert!(!list["users"].as_array().unwrap().iter().any(|u| u["account"] == json!("super@zabbix")), "a refused stranger makes no account");
}

/* ------------------------------ pins beat the map ------------------------------ */

#[tokio::test]
async fn a_role_set_by_hand_beats_the_map_including_a_map_that_would_refuse() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-pin");
    let (c, _) = hosted(&dir, &config(json!({})));
    let a = admin(&c).await;
    set_map(&c, &a, group_map()).await;
    let (_, out, _) = sign_in(&c, "b.singh", 1, None, &[("4", "Client A team")]).await;
    assert_eq!(out["role"], json!("user"));
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "b.singh@zabbix", "role": "operator" })).await;
    assert_eq!((r["ok"].clone(), r["pinned"].clone(), r["noAccess"].clone()), (json!(true), json!(true), json!(false)), "{r}");
    let (_, out, _) = sign_in(&c, "b.singh", 1, None, &[("4", "Client A team")]).await;
    assert_eq!((out["role"].clone(), out["pinned"].clone()), (json!("operator"), json!(true)), "{out}");
    // The map now refuses everybody in no group — the pin still signs them in.
    set_map(&c, &a, json!({ "unmapped": "none" })).await;
    let (status, out, _) = sign_in(&c, "b.singh", 1, None, &[("9", "Nothing mapped")]).await;
    assert_eq!((status, out["role"].clone()), (200, json!("operator")), "{out}");
    // Reset: the map decides again — and it refuses.
    let r = c.handle(json!({ "type": "USER_UNPIN_ROLE", "session": a, "name": "b.singh@zabbix" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let (status, _, _) = sign_in(&c, "b.singh", 1, None, &[("9", "Nothing mapped")]).await;
    assert_eq!(status, 403);
    let (_, out, _) = sign_in(&c, "b.singh", 1, None, &[("3", "NOC")]).await;
    assert_eq!(out["role"], json!("user"));
}

#[tokio::test]
async fn no_access_refuses_the_sign_in_the_code_and_every_request_until_reset() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-no-access");
    let (c, _) = hosted(&dir, &config(json!({})));
    let a = admin(&c).await;
    set_map(&c, &a, group_map()).await;
    let (_, _, open) = sign_in(&c, "c.ops", 2, Some("Admin role"), &[("3", "NOC"), ("4", "Client A team")]).await;
    let open = open.unwrap();
    // A code minted, not yet spent.
    let (_, minted) = signed(&c, claim("c.ops", 2, Some("Admin role"), &[("3", "NOC")]));
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "c.ops@zabbix", "role": "none" })).await;
    assert_eq!((r["ok"].clone(), r["pinned"].clone(), r["noAccess"].clone()), (json!(true), json!(true), json!(true)), "{r}");
    // The open session is gone, and a request from it is refused.
    let who = c.handle(json!({ "type": "WHOAMI", "session": open })).await;
    assert!(who["caller"].is_null(), "{who}");
    let es = c.handle(json!({ "type": "FLEET_STATE", "session": open })).await;
    assert_eq!(es["kind"], json!("unauthenticated"), "{es}");
    // The code minted before is worthless.
    let ex = c.handle(json!({ "type": "SSO_EXCHANGE", "code": minted["sso_code"] })).await;
    assert_eq!(ex["kind"], json!("bad_credentials"), "{ex}");
    // A fresh sign-in — Zabbix says Super admin now, in the admin group — is refused with its own reason.
    let (status, out, s) = sign_in(&c, "c.ops", 3, Some("Super admin role"), &[("1", "ElasticPro admins")]).await;
    assert_eq!((status, out["kind"].clone(), s), (403, json!("no_access"), None), "{out}");
    assert!(out["message"].as_str().unwrap().contains("No access"), "{out}");
    // The role lookup Cluster Management asks says no access in every field it could fall back on.
    let ts = now();
    let q = serde_json::to_vec(&json!({ "zabbix_user": "c.ops", "zabbix_user_type": 3, "zabbix_role": "Super admin role",
                                        "user_groups": [{ "id": "1", "name": "ElasticPro admins" }], "ts": ts, "nonce": nonce() })).unwrap();
    let reply = c.zabbix_sso_role_from(&q, &ZabbixSso::sign(SECRET.as_bytes(), &q), None);
    let body: Value = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!((reply.status, body["role"].clone(), body["zabbix_role"].clone(), body["no_access"].clone(), body["pinned"].clone()),
               (200, json!("none"), json!("none"), json!(true), json!(true)), "{body}");
    // The accounts list and the Zabbix users table say so too.
    let list = c.handle(json!({ "type": "USER_LIST", "session": a })).await;
    let row = list["users"].as_array().unwrap().iter().find(|u| u["name"] == "c.ops@zabbix").unwrap();
    assert_eq!((row["noAccess"].clone(), row["roleInForce"].clone(), row["rolePinned"].clone()), (json!(true), json!("none"), json!(true)), "{row}");
    let zu = c.handle(json!({ "type": "ZABBIX_USERS", "session": a })).await;
    let row = user(&zu, "c.ops@zabbix");
    assert_eq!((row["byHand"].clone(), row["inForce"].clone(), row["fromGroups"]["role"].clone()), (json!("none"), json!("none"), json!("admin")), "{row}");
    assert_eq!(zu["byHand"], json!(1));
    // Reset lifts it at once; the next sign-in follows the groups.
    let r = c.handle(json!({ "type": "USER_UNPIN_ROLE", "session": a, "name": "c.ops@zabbix" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let (status, out, _) = sign_in(&c, "c.ops", 3, Some("Super admin role"), &[("1", "ElasticPro admins")]).await;
    assert_eq!((status, out["role"].clone()), (200, json!("admin")), "{out}");
    // A real role set by hand also replaces No access.
    c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "c.ops@zabbix", "role": "none" })).await;
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "c.ops@zabbix", "role": "guest" })).await;
    assert_eq!((r["ok"].clone(), r["noAccess"].clone()), (json!(true), json!(false)), "{r}");
    let (status, out, _) = sign_in(&c, "c.ops", 3, None, &[]).await;
    assert_eq!((status, out["role"].clone()), (200, json!("guest")), "{out}");
    // No access is for accounts another system signs in; a local one is blocked instead.
    c.handle(json!({ "type": "USER_ADD", "session": a, "name": "local.bob", "password": "correct-horse-bob", "role": "user" })).await;
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "local.bob", "role": "none" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    // Nor on yourself.
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "Admin", "role": "none" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
}

/* --------------------------- the last administrator --------------------------- */

#[tokio::test]
async fn neither_a_map_nor_a_pin_may_leave_nobody_able_to_sign_in_as_an_administrator() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-last-admin");
    let (c, path) = hosted(&dir, &config(json!({})));
    let a = admin(&c).await;
    set_map(&c, &a, group_map()).await;
    // Two Zabbix administrators, from the admin group; then the local Admin goes.
    let (_, _, zed) = sign_in(&c, "zed", 3, Some("Super admin role"), &[("1", "ElasticPro admins")]).await;
    let zed = zed.unwrap();
    let (_, _, _yan) = sign_in(&c, "yan", 2, Some("Admin role"), &[("1", "ElasticPro admins"), ("3", "NOC")]).await;
    let r = c.handle(json!({ "type": "USER_REMOVE", "session": zed, "name": "Admin" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    // A map that makes neither an admin is refused, and the file is untouched.
    let before = file(&path);
    let bad = json!({ "groups": { "admin": [{ "id": "77", "name": "Nobody is here" }] }, "unmapped": "none" });
    let p = c.handle(json!({ "type": "ZABBIX_ROLEMAP_PREVIEW", "session": zed, "roleMap": bad })).await;
    assert_eq!((p["ok"].clone(), p["lockout"].clone(), p["adminsAfter"].clone()), (json!(true), json!(true), json!(0)), "{p}");
    let changed: Vec<&str> = p["changes"].as_array().unwrap().iter().map(|x| x["username"].as_str().unwrap()).collect();
    assert_eq!(changed, vec!["yan", "zed"], "both would lose admin: {p}");
    assert_eq!(p["changes"][1]["to"], json!("none"));
    let r = set_map(&c, &zed, bad).await;
    assert_eq!((r["ok"].clone(), r["kind"].clone()), (json!(false), json!("last_admin")), "{r}");
    assert_eq!(file(&path), before, "a refused map writes nothing");
    // A map under which yan stays an admin by another group is fine.
    let ok = json!({ "groups": { "admin": [{ "id": "3", "name": "NOC" }], "operator": [{ "id": "1", "name": "ElasticPro admins" }] }, "unmapped": "none" });
    let p = c.handle(json!({ "type": "ZABBIX_ROLEMAP_PREVIEW", "session": zed, "roleMap": ok.clone() })).await;
    assert_eq!((p["lockout"].clone(), p["adminsAfter"].clone()), (json!(false), json!(1)), "{p}");
    assert_eq!(p["changes"].as_array().unwrap().len(), 1, "only zed changes (to operator): {p}");
    assert_eq!((p["changes"][0]["username"].clone(), p["changes"][0]["to"].clone()), (json!("zed"), json!("operator")));
    let r = set_map(&c, &zed, ok).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    // zed is still admin until their next sign-in (nothing demotes a session mid-way).
    assert_eq!(c.handle(json!({ "type": "WHOAMI", "session": zed })).await["caller"]["role"], json!("admin"));

    // Pins: zed may not take their own admin away; yan may be set to No access by zed — but
    // then zed is the last admin able to sign in, so yan cannot do the same to zed.
    let (_, _, yan) = sign_in(&c, "yan", 2, Some("Admin role"), &[("1", "ElasticPro admins"), ("3", "NOC")]).await;
    let yan = yan.unwrap();
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": zed, "name": "zed@zabbix", "role": "none" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": zed, "name": "yan@zabbix", "role": "none" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    // yan's session is gone with it.
    assert_eq!(c.handle(json!({ "type": "USER_LIST", "session": yan })).await["kind"], json!("unauthenticated"));
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": zed, "name": "zed@zabbix", "role": "user" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "own role: {r}");
    // A second admin who signs in may not pin zed to No access while yan is out either.
    let (_, _, ulf) = sign_in(&c, "ulf", 1, None, &[("3", "NOC")]).await;
    let ulf = ulf.unwrap();
    c.handle(json!({ "type": "USER_SET_ROLE", "session": zed, "name": "ulf@zabbix", "role": "admin" })).await;
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": ulf, "name": "zed@zabbix", "role": "none" })).await;
    assert_eq!(r["ok"], json!(true), "ulf is a pinned admin now, so zed may go: {r}");
    let r = c.handle(json!({ "type": "USER_UNPIN_ROLE", "session": ulf, "name": "ulf@zabbix" })).await;
    assert_eq!(r["kind"], json!("forbidden"), "ulf is the last admin able to sign in: not handed back: {r}");
    let r = c.handle(json!({ "type": "USER_SET_ROLE", "session": ulf, "name": "ulf@zabbix", "role": "none" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
}

/* --------------------------------- migration --------------------------------- */

#[tokio::test]
async fn an_older_role_name_map_keeps_working_until_a_group_map_is_saved_and_underneath_it_after() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-migration");
    let (c, path) = hosted(&dir, &config(json!({ "roleMap": { "names": { "ES owners": "admin", "Nobody": "none" }, "types": { "2": "user" } } })));
    // Exactly as before: by role name, else by type; the groups a module sends change nothing.
    let (_, out, _) = sign_in(&c, "olga", 1, Some("ES owners"), &[("3", "NOC")]).await;
    assert_eq!((out["role"].clone(), out["source"].clone()), (json!("admin"), json!("zabbixRole")), "{out}");
    let (_, out, _) = sign_in(&c, "adam", 2, Some("Admin role"), &[("2", "NOC leads")]).await;
    assert_eq!(out["role"], json!("user"), "{out}");
    let (status, _, _) = sign_in(&c, "nemo", 3, Some("Nobody"), &[]).await;
    assert_eq!(status, 403);
    let a = admin(&c).await;
    let g = c.handle(json!({ "type": "ZABBIX_ROLEMAP_GET", "session": a })).await;
    assert_eq!(g["groupMapSaved"], json!(false), "{g}");
    assert_eq!(g["roleMap"]["names"]["ES owners"], json!("admin"));
    assert_eq!(g["roleMap"]["groups"], json!({ "admin": [], "operator": [], "user": [], "guest": [] }));
    assert_eq!(g["roleMap"]["unmapped"], json!("zabbixRole"));
    assert!(g["zabbixGroups"].is_null() && g["zabbixGroupsError"].is_string(), "no Zabbix is paired here: {g}");
    // The admin saves the group table — and only that.
    let r = set_map(&c, &a, json!({ "groups": { "operator": [{ "id": "2", "name": "NOC leads" }] } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let f = file(&path);
    assert_eq!(f["zabbix"]["roleMap"]["names"], json!({ "ES owners": "admin", "Nobody": "none" }), "the role-name map is kept: {f}");
    assert_eq!(f["zabbix"]["roleMap"]["types"], json!({ "1": "user", "2": "user", "3": "admin" }));
    assert_eq!(f["clusters"][0]["apiKey"], json!("alpha-api-key"), "the rest of the file is as it was");
    // Olga, in no mapped group, is still an admin by her role name; Adam is an operator by his group now.
    let (_, out, _) = sign_in(&c, "olga", 1, Some("ES owners"), &[("3", "NOC")]).await;
    assert_eq!(out["role"], json!("admin"), "{out}");
    let (_, out, _) = sign_in(&c, "adam", 2, Some("Admin role"), &[("2", "NOC leads")]).await;
    assert_eq!((out["role"].clone(), out["source"].clone()), (json!("operator"), json!("group")), "{out}");
    // The old message shape (names and types, no groups) still saves, and keeps the groups.
    let r = set_map(&c, &a, json!({ "names": { "ES owners": "operator" }, "types": { "2": "operator" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(file(&path)["zabbix"]["roleMap"]["groups"]["operator"], json!([{ "id": "2", "name": "NOC leads" }]));
}

/* ------------------------- the tables the Config page draws ------------------------- */

#[tokio::test]
async fn the_zabbix_users_table_and_the_preview_are_an_admins_and_describe_each_person() {
    let _turn = ENV.lock().await;
    let dir = TempDir::new("roles-tables");
    let (c, _) = hosted(&dir, &config(json!({})));
    let a = admin(&c).await;
    set_map(&c, &a, group_map()).await;
    let (_, _, op) = sign_in(&c, "a.kumar", 1, Some("User role"), &[("3", "NOC"), ("2", "NOC leads")]).await;
    sign_in(&c, "b.singh", 1, Some("User role"), &[("4", "Client A team")]).await;
    sign_in(&c, "d.new", 1, Some("User role"), &[("9", "Zabbix users")]).await;
    c.handle(json!({ "type": "USER_SET_ROLE", "session": a, "name": "b.singh@zabbix", "role": "operator" })).await;

    for t in ["ZABBIX_USERS", "ZABBIX_ROLEMAP_PREVIEW", "ZABBIX_ROLEMAP_GET"] {
        let r = c.handle(json!({ "type": t, "session": op.clone().unwrap(), "roleMap": {} })).await;
        assert_eq!(r["kind"], json!("forbidden"), "{t} is an admin's: {r}");
    }
    let list = c.handle(json!({ "type": "ZABBIX_USERS", "session": a })).await;
    assert_eq!((list["ok"].clone(), list["total"].clone(), list["byHand"].clone()), (json!(true), json!(3), json!(1)), "{list}");
    assert_eq!(list["groupsFrom"], json!("lastSignIn"), "no Zabbix is paired: the groups are those of the last sign-in: {list}");
    assert!(list["zabbixError"].is_string());
    let k = user(&list, "a.kumar@zabbix");
    assert_eq!(k["username"], json!("a.kumar"));
    assert_eq!(k["groups"], json!([{ "id": "3", "name": "NOC", "role": "user" }, { "id": "2", "name": "NOC leads", "role": "operator" }]), "{k}");
    assert_eq!((k["fromGroups"]["role"].clone(), k["fromGroups"]["via"].clone()), (json!("operator"), json!("NOC leads")), "{k}");
    assert_eq!(k["fromGroups"]["matched"], json!([{ "group": "NOC leads", "role": "operator" }, { "group": "NOC", "role": "user" }]), "highest first: {k}");
    assert_eq!((k["byHand"].clone(), k["inForce"].clone(), k["pinned"].clone()), (Value::Null, json!("operator"), json!(false)));
    assert!(k["lastSignIn"].is_u64() && k["known"] == json!(true), "{k}");
    let b = user(&list, "b.singh@zabbix");
    assert_eq!((b["fromGroups"]["role"].clone(), b["byHand"].clone(), b["inForce"].clone(), b["pinned"].clone()),
               (json!("user"), json!("operator"), json!("operator"), json!(true)), "{b}");
    let d = user(&list, "d.new@zabbix");
    assert_eq!((d["fromGroups"]["role"].clone(), d["fromGroups"]["source"].clone(), d["zabbixRole"].clone()),
               (json!("user"), json!("zabbixRole"), json!("User role")), "{d}");
    assert_eq!(d["groups"][0]["role"], Value::Null, "an unmapped group is marked so");

    // Preview: NOC leads becomes a user row and the unmapped rule no access. a.kumar drops to
    // user; d.new loses access; b.singh is pinned and does not move. Nothing is written.
    let draft = json!({ "groups": { "admin": [{ "id": "1", "name": "ElasticPro admins" }], "user": [{ "id": "2", "name": "NOC leads" }, { "id": "3", "name": "NOC" }] }, "unmapped": "none" });
    let p = c.handle(json!({ "type": "ZABBIX_ROLEMAP_PREVIEW", "session": a, "roleMap": draft })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    let changes = p["changes"].as_array().unwrap();
    assert_eq!(changes.iter().map(|x| (x["username"].as_str().unwrap(), x["from"].as_str().unwrap(), x["to"].as_str().unwrap())).collect::<Vec<_>>(),
               vec![("a.kumar", "operator", "user"), ("d.new", "user", "none")], "{p}");
    assert_eq!(changes[0]["via"], json!("NOC"), "the group that gives the new role");
    assert_eq!((p["lockout"].clone(), p["adminsAfter"].clone()), (json!(false), json!(1)), "the local Admin: {p}");
    let g = c.handle(json!({ "type": "ZABBIX_ROLEMAP_GET", "session": a })).await;
    assert_eq!(g["roleMap"]["unmapped"], json!("zabbixRole"), "the preview wrote nothing");
    assert_eq!(g["roleMap"]["groups"]["operator"], json!([{ "id": "2", "name": "NOC leads" }]));
    // A draft with a mistake is refused the same way a save would be.
    let p = c.handle(json!({ "type": "ZABBIX_ROLEMAP_PREVIEW", "session": a, "roleMap": { "groups": { "admin": ["NOC"], "user": ["NOC"] } } })).await;
    assert_eq!(p["kind"], json!("bad_message"), "{p}");
}
