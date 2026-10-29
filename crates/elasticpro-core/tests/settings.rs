//! config.txt through the real core: what ELASTICPRO_SETTINGS manages reaches the
//! environment the existing readers use, the `zabbix:` options, the trust switch and PING.
//!
//! Its own binary: the settings are loaded once per process and the environment is
//! process-wide.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::bridge::ZbxOptions;
use elasticpro_core::settings::{self, Settings};
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const CONFIG_TXT: &str = "\
# managed
NOTIFY_DAYS = 45
ZABBIX_URL=https://zabbix.example.com
ZABBIX_VERIFY_TLS=false
ACTIVITY_LOG_STDOUT=true
ES_CONCURRENCY=8
LOG_LEVEL=warn
UI_READ_ONLY=false
UI_REFRESH_SECONDS=90
UI_DISK_WARN_PERCENT=70
UI_TLS=insecure
UI_TIME_FIELD=ts
UI_VOLUME_COLLECT_AT=05:45
UI_VOLUME_SIZE_BASIS=eventsize
UI_VOLUME_INDEX_FORMAT=no-day-part-*
UI_MAX_LOG_ROWS=nonsense
ZABBIX_CREATE_HOSTS=true
ZABBIX_SCOPE_USERS_BY_GROUP=true
ZABBIX_HOST_GROUP=Lab
CACHE_MB=
LISTEN_PORT=443
SURPRISE=1
UI_SMTP_HOST=smtp.corp.example
UI_SMTP_USER=svc
UI_SMTP_PASSWORD_FILE=/run/secrets/smtp
";

#[tokio::test]
async fn config_txt_reaches_the_core() {
    let dir = TempDir::new("settings");
    let file = dir.join("config.txt");
    std::fs::write(&file, CONFIG_TXT).unwrap();
    // The environment says otherwise: config.txt wins over it.
    std::env::set_var("ELASTICPRO_NOTIFY_DAYS", "3");
    std::env::set_var("ELASTICPRO_CACHE_MB", "17");
    std::env::set_var(settings::ENV, &file);

    let s = settings::init();
    assert_eq!(s.warnings().len(), 3, "UI_MAX_LOG_ROWS, UI_VOLUME_INDEX_FORMAT and SURPRISE: {:?}", s.warnings());

    // The environment variables the existing readers consume.
    assert_eq!(elasticpro_core::notify::retention_days(), 45);
    assert_eq!(std::env::var("ELASTICPRO_ZABBIX_URL").unwrap(), "https://zabbix.example.com");
    assert_eq!(std::env::var("ELASTICPRO_ZABBIX_API_INSECURE").unwrap(), "1");
    assert_eq!(std::env::var("ELASTICPRO_ACTIVITY_STDOUT").unwrap(), "1");
    assert_eq!(std::env::var("ELASTICPRO_ES_CONCURRENCY").unwrap(), "8");
    assert!(std::env::var("RUST_LOG").unwrap().starts_with("warn"));
    assert_eq!(std::env::var("ELASTICPRO_CACHE_MB").unwrap(), "17", "an empty value is not managed: the environment stands");
    let server = elasticpro_core::zbx_link::ServerZbx::from_env();
    assert_eq!(server.zabbix_url.as_deref(), Some("https://zabbix.example.com"));
    assert_eq!(server.verify_tls, Some(false));
    assert!(server.managed().contains(&"zabbixUrl") && server.managed().contains(&"verifyTls"));

    // The zabbix: options, for every caller of from_config; the file fills in the rest.
    let from_file = json!({ "zabbix": { "createHosts": false, "useElasticProCredentials": true, "scopeUsersByGroup": false, "hostGroup": "File" } });
    let o = ZbxOptions::from_config(&from_file);
    assert!(o.create_hosts && o.scope_users_by_group, "config.txt beats the config file");
    assert_eq!(o.host_group, "Lab");
    assert!(o.use_elasticpro_credentials, "not managed: the config file decides");
    // ...and with no config file at all.
    assert!(ZbxOptions::from_config(&Value::Null).create_hosts);

    // PING, for a signed-in caller only.
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let anon = c.handle(json!({ "type": "PING" })).await;
    assert!(anon.get("managedDefaults").is_none(), "{anon}");
    let r = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let session = r["session"].as_str().unwrap().to_string();
    let ping = c.handle(json!({ "type": "PING", "session": session })).await;
    assert_eq!(ping["managedDefaults"], json!({
        "readOnly": false, "refreshIntervalSec": 90, "diskWarnPercent": 70, "tls": "insecure", "timeField": "ts",
        "volumeCollectAt": "05:45", "volumeSizeBasis": "eventSize"
    }), "only the managed keys, valid ones, under the UI's names: {ping}");
    assert_eq!(ping["managedZabbixOptions"], json!({ "createHosts": true, "scopeUsersByGroup": true, "hostGroup": "Lab" }));

    // The volume settings: config.txt over everything, and named as managed.
    let v = c.handle(json!({ "type": "VOLUME_SETTINGS", "session": session })).await;
    assert_eq!(v["managed"], json!(["volumeSizeBasis", "volumeCollectAt"]), "{v}");
    assert_eq!((v["settings"]["collectAt"].as_str(), v["settings"]["sizeBasis"].as_str()), (Some("05:45"), Some("eventSize")));
    assert_eq!(v["settings"]["indexFormat"], "logstash-*-YYYY.MM.DD", "an invalid managed value is not managed");

    // A password from config.txt goes only to the server config.txt names: the whole
    // destination is locked on the page, the port and security included.
    let m = c.handle(json!({ "type": "MAIL_SETTINGS_GET", "session": session })).await;
    assert_eq!((m["host"].as_str(), m["port"].as_u64(), m["security"].as_str(), m["user"].as_str()),
               (Some("smtp.corp.example"), Some(587), Some("starttls"), Some("svc")), "{m}");
    assert_eq!(m["passwordFrom"], "config.txt", "{m}");
    for f in ["host", "port", "security", "user", "auth", "password"] {
        assert!(m["managed"].as_array().unwrap().iter().any(|x| x == f), "{f} is locked: {m}");
    }
    for change in [json!({ "port": 2525 }), json!({ "security": "tls" }), json!({ "user": "someone" }), json!({ "host": "mail.attacker.example" })] {
        let mut set = json!({ "type": "MAIL_SETTINGS_SET", "session": session });
        set.as_object_mut().unwrap().extend(change.as_object().unwrap().clone());
        let r = c.handle(set).await;
        assert_eq!(r["kind"], "managed", "{change}: {r}");
    }
    let r = c.handle(json!({ "type": "MAIL_SETTINGS_SET", "session": session, "port": 587, "from": "ep@example.com" })).await;
    assert_eq!(r["ok"], true, "a locked field sent as it is, and an unlocked one changed: {r}");
}

#[test]
fn zbx_options_honour_overrides_and_fall_back() {
    let file = json!({ "zabbix": { "createHosts": true, "hostGroup": "File", "scopeUsersByGroup": true } });
    let none = ZbxOptions::from_config_with(&file, &Settings::default());
    assert!(none.create_hosts && none.scope_users_by_group);
    assert_eq!(none.host_group, "File");
    let off = Settings::parse("ZABBIX_CREATE_HOSTS=false\nZABBIX_SCOPE_USERS_BY_GROUP=false\nZABBIX_USE_ELASTICPRO_CREDENTIALS=true\nZABBIX_HOST_GROUP=Managed\n");
    let o = ZbxOptions::from_config_with(&file, &off);
    assert!(!o.create_hosts && !o.scope_users_by_group, "a managed false beats a file true");
    assert!(o.use_elasticpro_credentials);
    assert_eq!(o.host_group, "Managed");
    assert_eq!(ZbxOptions::from_config_with(&Value::Null, &Settings::default()).host_group, "Elasticsearch clusters");
}
