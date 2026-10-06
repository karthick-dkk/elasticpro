//! `CONFIG_VIEW`: the config for somebody who may not read the config file.
//!
//! Its own test binary because it needs `ELASTICPRO_CONFIG`, which is process-wide, and
//! every other test builds cores that must not see it.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::zbx_sso::ZabbixSso;
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const SECRET: &str = "integration-secret-0123456789abcdef-xyz";

async fn zabbix_session(c: &std::sync::Arc<Core>, user: &str, ty: i64, groups: &[&str]) -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let body = serde_json::to_vec(&json!({ "username": user, "zabbix_user_type": ty, "groups": groups,
        "ts": ts.as_secs(), "nonce": format!("nonce-{}", ts.as_nanos()) })).unwrap();
    let (_, out) = c.zabbix_sso_init(&body, &ZabbixSso::sign(SECRET.as_bytes(), &body));
    let res = c.handle(json!({ "type": "SSO_EXCHANGE", "code": out["sso_code"] })).await;
    res["session"].as_str().expect("a session").to_string()
}

const CONFIG: &str = r#"
credentials: { username: fleet, password: fleet-password }
jump_hosts:
  jumpa: { host: jump-a.example, user: ops, keyFile: /keys/a }
  jumpb: { host: jump-b.example, user: ops, keyFile: /keys/b }
clusters:
  - name: Alpha
    url: https://svc:alpha-url-password@alpha.example:9200
    via: jumpa
    username: alpha-svc
    apiKey: alpha-api-key
    zabbixGroups: [ES alpha]
    s3: { bucket: alpha-archive, auth: { accessKeyId: AKIAALPHA, secretAccessKey: alpha-s3-secret } }
  - name: Beta
    url: https://beta.example:9200
    via: jumpb
    password: enc:v1:sealed-beta
    zabbix_groups: ES beta
  - name: Gamma
    url: https://gamma.example:9200
defaults: { logIndexPattern: "logstash-*" }
"#;

#[tokio::test]
async fn the_config_view_holds_no_credentials_and_only_your_clusters() {
    let dir = TempDir::new("zbx-view");
    let path = dir.join("clusters.yaml");
    std::fs::write(&path, CONFIG).unwrap();
    std::env::set_var("ELASTICPRO_CONFIG", &path);
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    c.zabbix_sso().set_secret(SECRET).unwrap();

    // A scoped user: Alpha only, and only Alpha's jump host.
    let s = zabbix_session(&c, "uma", 1, &["ES alpha"]).await;
    let r = c.handle(json!({ "type": "CONFIG_VIEW", "session": s })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let text = r["text"].as_str().unwrap();
    for secret in ["fleet-password", "alpha-url-password", "alpha-api-key", "AKIAALPHA", "alpha-s3-secret",
                   "enc:v1", "/keys/a", "\"fleet\"", "alpha-svc"] {
        assert!(!text.contains(secret), "{secret} leaked into the view:\n{text}");
    }
    let v: Value = serde_json::from_str(text).unwrap();
    let names: Vec<&str> = v["clusters"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Alpha"]);
    assert_eq!(v["clusters"][0]["url"], json!("https://alpha.example:9200"), "user:pass@ is taken out of URLs");
    assert_eq!(v["clusters"][0]["s3"]["bucket"], json!("alpha-archive"), "what is not a credential stays");
    assert!(v["jump_hosts"].get("jumpb").is_none(), "someone else's jump host");
    assert_eq!(v["jump_hosts"]["jumpa"]["host"], json!("jump-a.example"));
    assert_eq!(v["defaults"]["logIndexPattern"], json!("logstash-*"));

    // An operator sees every cluster, still with nothing secret in it.
    let s = zabbix_session(&c, "adam", 2, &[]).await;
    let r = c.handle(json!({ "type": "CONFIG_VIEW", "session": s })).await;
    let v: Value = serde_json::from_str(r["text"].as_str().unwrap()).unwrap();
    assert_eq!(v["clusters"].as_array().unwrap().len(), 3);
    assert!(!r["text"].as_str().unwrap().contains("fleet-password"));
    // Index kept so ids agree with the admin's view even after filtering.
    assert_eq!(v["clusters"][2]["_index"], json!(2));

    // And the path is the server's, never the caller's.
    let r = c.handle(json!({ "type": "CONFIG_VIEW", "session": s, "path": "/etc/passwd" })).await;
    assert!(!r["text"].as_str().unwrap_or("").contains("root:"));
}
