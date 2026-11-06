//! Backup and restore (docs/HANDBOOK.md "Backup and restore — the message contract"): who may
//! ask, what a file holds and never holds, that a wrong password is refused, that a preview
//! writes nothing, that a restore keeps the current state first and goes through the config
//! write path, and that the daily timer runs once a day and rotates.
//!
//! Its own test binary: it needs ELASTICPRO_CONFIG, which is process-wide, so the tests take
//! turns on one lock and each sets its own file.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_link::ServerZbx;
use elasticpro_core::Core;
use elasticpro_core::backup::SectionData;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use support::TempDir;

static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const PASSWORD: &str = "correct-horse-battery";
const BACKUP_PW: &str = "backup-password-2026";
const CLUSTER_PW: &str = "alpha-secret-pw-77";
const DEFAULT_PW: &str = "default-secret-pw-88";
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn config() -> Value {
    json!({
        "version": 2,
        "credentials": { "username": "fleet", "password": "fleet-shared-pw-99" },
        "defaults": { "logIndexPattern": "logs-*", "volume": { "fields": ["a"] } },
        "jump_hosts": { "jumpa": { "host": "jump-a.example", "user": "ops", "keyFile": "/keys/a" } },
        "clusters": [
            { "name": "Alpha", "url": "https://alpha.example:9200", "password": CLUSTER_PW, "tags": ["prod"] },
            { "name": "Beta", "url": "https://svc:url-pw-55@beta.example:9200", "tags": ["lab"] }
        ],
        "alerts": [ { "id": "t1", "level": "warn" }, { "id": "t2", "level": "crit" } ],
        // As the app saves them: every automation has its own id (cluster_save::apply_automations,
        // which a restore goes through like any save).
        "automations": [ { "id": "r1", "name": "Rule one", "when": "x", "then": "y" } ]
    })
}

fn hosted(dir: &TempDir, cfg: &Value) -> (Arc<Core>, std::path::PathBuf) {
    let path = dir.join("config_cluster.json");
    std::fs::write(&path, serde_json::to_string_pretty(cfg).unwrap()).unwrap();
    std::env::set_var("ELASTICPRO_CONFIG", &path);
    (Core::new_with_server_zbx(Some(dir.0.clone()), Edition::Hosted, 1, ServerZbx::default()), path)
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn send(c: &Arc<Core>, s: &str, mut msg: Value) -> Value {
    msg["session"] = json!(s);
    c.handle(msg).await
}

fn names_in(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    v.sort();
    v
}

fn section<'a>(p: &'a Value, id: &str) -> &'a Value {
    p["preview"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap_or_else(|| panic!("no section {id} in {p}"))
}

#[tokio::test]
async fn admins_only_no_secret_in_the_clear_wrong_password_refused_preview_writes_nothing_restore_undoable() {
    let _turn = TURN.lock().await;
    let dir = TempDir::new("backup");
    let (c, cfg_path) = hosted(&dir, &config());
    let s = admin(&c).await;

    // PING says so before anyone signs in.
    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["backup"]["supported"], json!(true), "{ping}");
    assert_eq!(ping["backup"]["scheduled"], json!(true));

    // Operators are refused; the gate's default for an unknown type is admin, and a limited
    // admin is refused by the handler.
    let add = send(&c, &s, json!({ "type": "USER_ADD", "name": "op", "password": "operator-pw-0123", "role": "operator" })).await;
    assert_eq!(add["ok"], json!(true), "{add}");
    let l = c.handle(json!({ "type": "LOGIN", "name": "op", "password": "operator-pw-0123" })).await;
    let op = l["session"].as_str().unwrap_or_else(|| panic!("operator login: {l}")).to_string();
    for t in ["BACKUP_STATUS", "BACKUP_CREATE", "BACKUP_PREVIEW", "BACKUP_RESTORE", "BACKUP_SCHEDULE_SET", "BACKUP_DOWNLOAD", "BACKUP_DELETE"] {
        let r = send(&c, &op, json!({ "type": t })).await;
        assert_eq!(r["ok"], json!(false), "{t}: {r}");
        assert_eq!(r["kind"], json!("forbidden"), "{t}: {r}");
    }

    // Secrets this server keeps: a cluster credential, the default, a Zabbix link with a token.
    let r = send(&c, &s, json!({ "type": "CREDENTIAL_SET", "cluster": "*", "username": "elastic", "password": DEFAULT_PW })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let r = send(&c, &s, json!({ "type": "ZABBIX_LINK_SET", "zabbixUrl": "https://zbx.example.com/", "apiToken": TOKEN, "syncSecs": 120 })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    let status = send(&c, &s, json!({ "type": "BACKUP_STATUS" })).await;
    assert_eq!(status["ok"], json!(true), "{status}");
    assert_eq!(status["keeps"], json!(true));
    assert_eq!(status["schedule"]["enabled"], json!(true), "shipped on");
    assert_eq!(status["schedule"]["at"], json!("02:00"));
    assert_eq!(status["schedule"]["keep"], json!(14));
    assert_eq!(status["sections"].as_array().unwrap().len(), 9);

    // 1. Without a password: not one secret in the file, and the file says what was left out.
    let plain = send(&c, &s, json!({ "type": "BACKUP_CREATE" })).await;
    assert_eq!(plain["ok"], json!(true), "{plain}");
    let text = plain["file"].as_str().unwrap();
    for secret in [CLUSTER_PW, DEFAULT_PW, "fleet-shared-pw-99", "url-pw-55", TOKEN] {
        assert!(!text.contains(secret), "{secret} is in a backup made without a password");
    }
    assert_eq!(plain["credentials"], json!("none"));
    assert!(plain["leftOut"].as_u64().unwrap() >= 4, "{plain}");
    let doc: Value = serde_json::from_str(text).unwrap();
    assert!(doc["credentials"].is_null());
    assert_eq!(doc["sections"]["clusters"]["items"]["Beta"]["config"]["url"], json!("https://beta.example:9200"), "userinfo stripped from the URL");
    assert!(doc["sections"]["clusters"]["items"]["Alpha"]["config"].get("password").is_none());
    let link = &doc["sections"]["zabbix"]["items"]["link"];
    assert_eq!(link["zabbixUrl"], json!("https://zbx.example.com"));
    assert!(link.get("apiToken").is_none() && link.get("ssoSecret").is_none(), "{link}");

    // 2. A short password is refused; a real one seals the secrets, still never in the clear.
    let weak = send(&c, &s, json!({ "type": "BACKUP_CREATE", "password": "short" })).await;
    assert_eq!(weak["kind"], json!("weak_password"), "{weak}");
    let sealed = send(&c, &s, json!({ "type": "BACKUP_CREATE", "password": BACKUP_PW, "keep": true })).await;
    assert_eq!(sealed["ok"], json!(true), "{sealed}");
    let sealed_text = sealed["file"].as_str().unwrap().to_string();
    for secret in [CLUSTER_PW, DEFAULT_PW, "fleet-shared-pw-99", "url-pw-55", TOKEN] {
        assert!(!sealed_text.contains(secret), "{secret} is in a sealed backup in the clear");
    }
    assert_eq!(sealed["credentials"], json!("password"));
    assert!(sealed["secrets"].as_u64().unwrap() >= 4, "{sealed}");
    assert_eq!(sealed["kept"], json!(true));
    let kept_name = sealed["name"].as_str().unwrap().to_string();
    let backups = dir.join("backups");
    assert!(backups.join(&kept_name).is_file(), "kept on the server");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(backups.join(&kept_name)).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&backups).unwrap().permissions().mode() & 0o777, 0o700);
    }
    // The kept copy is sealed under the server's key, never with the password, and never in the clear either.
    let kept_text = std::fs::read_to_string(backups.join(&kept_name)).unwrap();
    let kept_doc: Value = serde_json::from_str(&kept_text).unwrap();
    assert_eq!(kept_doc["credentials"]["scheme"], json!("server"));
    assert!(!kept_text.contains(CLUSTER_PW) && !kept_text.contains(TOKEN));
    let st = send(&c, &s, json!({ "type": "BACKUP_STATUS" })).await;
    assert_eq!(st["kept"].as_array().unwrap().len(), 1, "{st}");
    assert_eq!(st["kept"][0]["kind"], json!("manual"));
    assert_eq!(st["kept"][0]["credentials"], json!("server"));

    // 3. Preview: the wrong password is refused; the right one opens; nothing is written.
    let before_files = names_in(&dir.0);
    let before_cfg = std::fs::read_to_string(&cfg_path).unwrap();
    let wrong = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": sealed_text, "password": "backup-password-2027" })).await;
    assert_eq!(wrong["kind"], json!("bad_password"), "{wrong}");
    let locked = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": sealed_text })).await;
    assert_eq!(locked["ok"], json!(true), "{locked}");
    assert_eq!(locked["credentials"]["state"], json!("locked"));
    let same = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": sealed_text, "password": BACKUP_PW })).await;
    assert_eq!(same["ok"], json!(true), "{same}");
    assert_eq!(same["credentials"]["state"], json!("opened"));
    let cl = section(&same, "clusters");
    assert_eq!(cl["add"], json!([]));
    assert_eq!(cl["change"], json!([]));
    assert_eq!(cl["same"], json!(3), "Alpha, Beta and the shared credential: {cl}");
    assert_eq!(section(&same, "alerts")["same"], json!(3), "two triggers and a rule");
    assert_eq!(names_in(&dir.0), before_files, "a preview writes no file");
    assert_eq!(std::fs::read_to_string(&cfg_path).unwrap(), before_cfg, "a preview touches no config");

    // 4. Change the world: Beta gone, Alpha's tags changed, the default credential forgotten.
    let mut changed = config();
    changed["clusters"] = json!([{ "name": "Alpha", "url": "https://alpha.example:9200", "tags": ["moved"] },
                                 { "name": "Gamma", "url": "https://gamma.example:9200" }]);
    let w = send(&c, &s, json!({ "type": "CONFIG_WRITE", "path": cfg_path.display().to_string(), "text": changed.to_string() })).await;
    assert_eq!(w["ok"], json!(true), "{w}");
    let r = send(&c, &s, json!({ "type": "CREDENTIAL_CLEAR", "cluster": "*" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let p = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": sealed_text, "password": BACKUP_PW, "sections": ["clusters"] })).await;
    let cl = section(&p, "clusters");
    assert_eq!(cl["add"], json!(["Beta"]), "{cl}");
    assert_eq!(cl["change"], json!(["Alpha"]), "{cl}");
    assert_eq!(cl["onlyHere"], json!(["Gamma"]), "{cl}");

    // 5. Restore (merge): the current state is kept first; the config goes through the config
    // write path (a version kept, the restorer recorded); the credential is back, re-sealed.
    let no_mode = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": sealed_text, "password": BACKUP_PW })).await;
    assert_eq!(no_mode["kind"], json!("bad_request"), "{no_mode}");
    let needs_pw = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": sealed_text, "mode": "merge" })).await;
    assert_eq!(needs_pw["kind"], json!("password_needed"), "{needs_pw}");
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": sealed_text, "password": BACKUP_PW, "mode": "merge", "sections": ["clusters", "alerts"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let before = r["beforeRestore"].as_str().expect("a before-restore backup").to_string();
    assert!(before.contains("before-restore"), "{before}");
    assert!(backups.join(&before).is_file());
    let applied = r["applied"].as_array().unwrap();
    let cl = applied.iter().find(|a| a["id"] == "clusters").unwrap();
    assert_eq!(cl["added"], json!(1));
    assert_eq!(cl["changed"], json!(1));
    assert_eq!(cl["removed"], json!(0), "merge removes nothing");
    let after: Value = elasticpro_core::bridge::parse_config_text(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    let names: Vec<&str> = after["clusters"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Alpha", "Gamma", "Beta"], "merge: existing order, Beta appended");
    assert_eq!(after["clusters"][0]["tags"], json!(["prod"]));
    assert_eq!(after["clusters"][0]["password"], json!(CLUSTER_PW), "the password came back from the sealed credentials");
    assert_eq!(after["clusters"][2]["url"], json!("https://svc:url-pw-55@beta.example:9200"), "userinfo back in the URL");
    assert_eq!(after["credentials"]["password"], json!("fleet-shared-pw-99"));
    let hist = send(&c, &s, json!({ "type": "CONFIG_HISTORY" })).await;
    assert_eq!(hist["current"]["saved_by"], json!("Admin"), "{hist}");
    assert!(hist["versions"].as_array().unwrap().len() >= 2, "a version was kept by the restore: {hist}");
    let st = send(&c, &s, json!({ "type": "CREDENTIAL_STATUS" })).await;
    assert!(st["entries"].as_array().map(|e| e.iter().any(|x| x["name"] == "*")).unwrap_or(false)
            || st.to_string().contains("\"*\""), "the default credential is back: {st}");
    // The before-restore backup carries what was there, so this can be undone.
    let undo = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "name": before, "sections": ["clusters"] })).await;
    assert_eq!(undo["ok"], json!(true), "{undo}");
    assert_eq!(undo["credentials"]["state"], json!("opened"), "server-sealed: this server opens it");
    assert_eq!(section(&undo, "clusters")["onlyHere"], json!(["Beta"]));

    // 6. Replace: what is only here now goes.
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": sealed_text, "password": BACKUP_PW, "mode": "replace", "sections": ["clusters"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let after: Value = elasticpro_core::bridge::parse_config_text(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    let names: Vec<&str> = after["clusters"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Alpha", "Beta"]);
    assert_eq!(after["alerts"].as_array().unwrap().len(), 2, "a section not asked for is untouched");

    // 6b. A merge of a backup made WITHOUT a password never costs a cluster its live password:
    // Alpha, Beta's URL userinfo and the shared credential are all still here afterwards.
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": text, "mode": "merge", "sections": ["clusters"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["credentials"], json!("none"));
    let after: Value = elasticpro_core::bridge::parse_config_text(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    assert_eq!(after["clusters"][0]["password"], json!(CLUSTER_PW), "merge without credentials kept the live password");
    assert_eq!(after["clusters"][1]["url"], json!("https://svc:url-pw-55@beta.example:9200"), "and the userinfo");
    assert_eq!(after["credentials"]["password"], json!("fleet-shared-pw-99"), "and the shared credential");
    let notes = r["applied"].as_array().unwrap().iter().find(|a| a["id"] == "clusters").unwrap()["notes"].to_string();
    assert!(notes.contains("were kept"), "{notes}");
    // A Replace with the same file says the opposite, and means it.
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": text, "mode": "replace", "sections": ["clusters"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let after: Value = elasticpro_core::bridge::parse_config_text(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    assert!(after["clusters"][0].get("password").is_none(), "replace without credentials: the clusters ask again");
    // Put the passwords back for the steps below.
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": sealed_text, "password": BACKUP_PW, "mode": "merge", "sections": ["clusters"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    // 7. The Zabbix token is never in a backup, and a restore of the link does not bring one.
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": sealed_text, "password": BACKUP_PW, "mode": "merge", "sections": ["zabbix"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let zl = send(&c, &s, json!({ "type": "ZABBIX_LINK_GET" })).await;
    assert_eq!(zl["zabbixUrl"], json!("https://zbx.example.com"), "{zl}");
    let znotes = r["applied"].as_array().unwrap().iter().find(|a| a["id"] == "zabbix").unwrap()["notes"].to_string();
    assert!(znotes.contains("already holds was kept"), "the note says the token here was kept, not 'pair again': {znotes}");
    let link_file = std::fs::read_to_string(dir.join("zabbix-link.json")).unwrap();
    assert!(link_file.contains(TOKEN), "the token this server already had stays; the backup neither carries nor clears it");

    // 8. A newer format, a damaged file and a stranger's file are refused.
    let mut v: Value = serde_json::from_str(&sealed_text).unwrap();
    v["formatVersion"] = json!(99);
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": v.to_string(), "mode": "merge" })).await;
    assert_eq!(r["kind"], json!("newer_format"), "{r}");
    let r = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": sealed_text.replace("\"Alpha\"", "\"Alph4\"") })).await;
    assert_eq!(r["kind"], json!("corrupt"), "{r}");
    let r = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": "{\"hello\":1}" })).await;
    assert_eq!(r["kind"], json!("not_a_backup"), "{r}");
    let r = send(&c, &s, json!({ "type": "BACKUP_DOWNLOAD", "name": "../users.json" })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");

    // 8b. A crafted (unsealed, re-digested) file: a pin that is not a digest is skipped and said;
    // a Replace of Requests removes nothing (the preview files policy and defaults under
    // keptAnyway); a role item for the restoring admin's own account is refused by the same
    // rule as USER_SET_ROLE; the file's provenance is labelled as what it says.
    let mut crafted: Value = serde_json::from_str(text).unwrap();
    let mut sections: BTreeMap<String, SectionData> = serde_json::from_value(crafted["sections"].clone()).unwrap();
    let hexd = "ab".repeat(32);
    let trust = sections.entry("trust".into()).or_default();
    trust.items.insert("cert:good.example".into(), json!({ "sha256": hexd, "subject": "CN=good" }));
    trust.items.insert("cert:bad.example".into(), json!({ "sha256": "nothash", "subject": "CN=bad" }));
    trust.items.insert("hostkey:jumpz".into(), json!({ "sha256": "SHA256:not-base64-at-all", "subject": "ssh-ed25519" }));
    sections.insert("requests".into(), SectionData::default());
    sections.entry("zabbix".into()).or_default().items.insert("role:Admin".into(), json!({ "role": "user", "noAccess": false }));
    sections.entry("zabbix".into()).or_default().items.insert("role:nobody-here".into(), json!({ "role": "user", "noAccess": false }));
    crafted["sections"] = serde_json::to_value(&sections).unwrap();
    crafted["digest"] = json!(elasticpro_core::backup::digest_of(&sections));
    crafted["takenBy"] = json!("mallory");
    let crafted_text = crafted.to_string();
    let p = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": crafted_text, "sections": ["requests", "trust"] })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    assert_eq!(p["backup"]["says"]["takenBy"], json!("mallory"));
    assert_eq!(p["backup"]["says"]["verified"], json!(false), "who took it is the file's word");
    let rq = section(&p, "requests");
    assert_eq!(rq["onlyHere"], json!([]), "a Replace removes neither the policy nor Defaults: {rq}");
    assert_eq!(rq["keptAnyway"], json!(["defaults", "policy"]), "{rq}");
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": crafted_text, "mode": "replace", "sections": ["requests", "trust", "zabbix"] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let applied = r["applied"].as_array().unwrap();
    let rq = applied.iter().find(|a| a["id"] == "requests").unwrap();
    assert_eq!(rq["removed"], json!(0), "{rq}");
    let after: Value = elasticpro_core::bridge::parse_config_text(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
    assert_eq!(after["defaults"]["logIndexPattern"], json!("logs-*"), "Defaults survived a Replace that brought none");
    let tn = applied.iter().find(|a| a["id"] == "trust").unwrap()["notes"].to_string();
    assert!(tn.contains("cert:bad.example") && tn.contains("64 hex"), "{tn}");
    assert!(tn.contains("hostkey:jumpz"), "{tn}");
    let p = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "file": crafted_text, "sections": ["trust"] })).await;
    let tr = section(&p, "trust");
    assert!(tr["same"].as_u64().unwrap() >= 1, "the good pin is here now: {tr}");
    assert!(tr["add"].as_array().unwrap().iter().any(|k| k == "cert:bad.example"), "the bad one still is not: {tr}");
    assert!(tr["add"].as_array().unwrap().iter().any(|k| k == "hostkey:jumpz"), "{tr}");
    let zn = applied.iter().find(|a| a["id"] == "zabbix").unwrap()["notes"].to_string();
    assert!(zn.contains("Admin") && zn.contains("own administrator role"), "{zn}");
    assert!(zn.contains("nobody-here"), "{zn}");
    let me = send(&c, &s, json!({ "type": "WHOAMI" })).await;
    assert_eq!(me["caller"]["role"], json!("admin"), "the restoring admin is still an admin: {me}");

    // 9. Download and delete a kept one.
    let r = send(&c, &s, json!({ "type": "BACKUP_DOWNLOAD", "name": kept_name })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["file"].as_str().unwrap(), kept_text);
    let r = send(&c, &s, json!({ "type": "BACKUP_DELETE", "name": kept_name })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert!(!backups.join(&kept_name).exists());

    // 10. The schedule: checked, saved, and never given a password.
    let r = send(&c, &s, json!({ "type": "BACKUP_SCHEDULE_SET", "schedule": { "at": "03:30", "keep": 7, "every": "week" } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["schedule"]["at"], json!("03:30"));
    assert_eq!(r["schedule"]["keep"], json!(7));
    let r = send(&c, &s, json!({ "type": "BACKUP_SCHEDULE_SET", "schedule": { "password": BACKUP_PW } })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    let r = send(&c, &s, json!({ "type": "BACKUP_SCHEDULE_SET", "schedule": { "at": "3:30" } })).await;
    assert_eq!(r["kind"], json!("bad_request"), "{r}");
    let sched = std::fs::read_to_string(backups.join("schedule.json")).unwrap();
    assert!(!sched.contains(BACKUP_PW) && sched.contains("03:30"));

    // Nothing secret went to the activity or audit record through these replies: the replies
    // never carried the backup password back.
    for r in [&plain, &sealed, &same, &wrong] {
        assert!(!r.to_string().contains(BACKUP_PW));
    }
}

#[tokio::test]
async fn the_timer_runs_once_a_day_keeps_the_last_n_and_seals_under_the_server_key() {
    let _turn = TURN.lock().await;
    let dir = TempDir::new("backup-timer");
    let (c, _) = hosted(&dir, &config());
    let s = admin(&c).await;
    let r = send(&c, &s, json!({ "type": "BACKUP_SCHEDULE_SET", "schedule": { "keep": 2, "sections": ["clusters", "trust"] } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let at = |t: &str| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M").unwrap();

    assert!(c.backup_tick_at(at("2026-11-05 01:59")).await.is_none(), "not yet");
    let first = c.backup_tick_at(at("2026-11-05 02:00")).await.expect("due").expect("ok");
    assert!(first.ends_with("-scheduled.epbak"), "{first}");
    assert!(c.backup_tick_at(at("2026-11-05 02:01")).await.is_none(), "once a day");
    assert!(c.backup_tick_at(at("2026-11-05 23:59")).await.is_none());
    let second = c.backup_tick_at(at("2026-11-06 02:00")).await.expect("due").expect("ok");
    assert_ne!(first, second);
    let third = c.backup_tick_at(at("2026-11-07 02:00")).await.expect("due").expect("ok");

    let backups = dir.join("backups");
    let mut kept: Vec<String> = names_in(&backups).into_iter().filter(|n| n.ends_with(".epbak")).collect();
    kept.sort();
    assert_eq!(kept.len(), 2, "keep 2: {kept:?}");
    assert!(!backups.join(&first).exists(), "the oldest went first");
    assert!(backups.join(&third).exists());

    let st = send(&c, &s, json!({ "type": "BACKUP_STATUS" })).await;
    assert_eq!(st["schedule"]["last"]["ok"], json!(true), "{st}");
    assert_eq!(st["schedule"]["last"]["localDay"], json!("2026-11-07"));
    assert_eq!(st["kept"][0]["kind"], json!("scheduled"));
    assert_eq!(st["kept"][0]["credentials"], json!("server"));
    assert_eq!(st["kept"][0]["sections"], json!(["clusters", "trust"]));
    let text = std::fs::read_to_string(backups.join(&third)).unwrap();
    assert!(!text.contains(CLUSTER_PW), "sealed under the server key, never in the clear");
    // This server opens its own scheduled backup.
    let p = send(&c, &s, json!({ "type": "BACKUP_PREVIEW", "name": third })).await;
    assert_eq!(p["ok"], json!(true), "{p}");
    assert_eq!(p["credentials"]["state"], json!("opened"));
    assert_eq!(section(&p, "clusters")["present"], json!(true));
    assert!(!section(&p, "play")["present"].as_bool().unwrap(), "a section not in the schedule is not in the file");

    // Off: never due.
    let r = send(&c, &s, json!({ "type": "BACKUP_SCHEDULE_SET", "schedule": { "enabled": false } })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    assert!(c.backup_tick_at(at("2026-11-08 02:00")).await.is_none());
    assert!(r["schedule"]["next"].is_null());
}

#[tokio::test]
async fn without_a_server_key_nothing_is_kept_credential_less() {
    let _turn = TURN.lock().await;
    // A configured key that is not one: the store opens with a problem and cannot seal.
    std::env::set_var("ELASTICPRO_CLUSTER_SECRET_KEY", "not-a-key");
    let dir = TempDir::new("backup-nokey");
    let (c, _) = hosted(&dir, &config());
    std::env::remove_var("ELASTICPRO_CLUSTER_SECRET_KEY");
    let s = admin(&c).await;
    let st = send(&c, &s, json!({ "type": "BACKUP_STATUS" })).await;
    assert_eq!(st["serverSealing"], json!(false), "{st}");
    // A download still works: with a password (sealed) or without one (said to be without).
    let dl = send(&c, &s, json!({ "type": "BACKUP_CREATE", "password": BACKUP_PW })).await;
    assert_eq!(dl["ok"], json!(true), "{dl}");
    assert_eq!(dl["credentials"], json!("password"));
    let plain = send(&c, &s, json!({ "type": "BACKUP_CREATE" })).await;
    assert_eq!(plain["credentials"], json!("none"));
    // But nothing is kept on this server with its credentials silently missing.
    let kept = send(&c, &s, json!({ "type": "BACKUP_CREATE", "keep": true })).await;
    assert_eq!(kept["kind"], json!("no_server_key"), "{kept}");
    let r = send(&c, &s, json!({ "type": "BACKUP_RESTORE", "file": dl["file"], "password": BACKUP_PW, "mode": "merge", "sections": ["alerts"] })).await;
    assert_eq!(r["kind"], json!("no_server_key"), "{r}");
    assert!(r["message"].as_str().unwrap().contains("nothing was restored"), "{r}");
    let at = chrono::NaiveDateTime::parse_from_str("2026-11-05 02:00", "%Y-%m-%d %H:%M").unwrap();
    let tick = c.backup_tick_at(at).await.expect("due");
    assert!(tick.is_err(), "the timer refuses too: {tick:?}");
    let st = send(&c, &s, json!({ "type": "BACKUP_STATUS" })).await;
    assert_eq!(st["schedule"]["last"]["ok"], json!(false), "{st}");
    assert!(st["schedule"]["last"]["message"].as_str().unwrap().contains("no key"), "{st}");
    assert_eq!(st["kept"].as_array().unwrap().len(), 0);
}
