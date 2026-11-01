//! Shared acknowledgements (docs/PLAY.md) and their audit lines, in a test binary of their own.
//!
//! Why its own binary: the test captures the `audit` lines with a thread-local subscriber
//! (`tracing::subscriber::set_default`). While that is the only scoped subscriber in the
//! process, tracing-core takes its "just one dispatcher" path and works out a callsite's
//! interest from the default of whichever thread hits the callsite *first* — and caches it
//! for every thread. In tests/play.rs other tests run in parallel and send ACK_SET too; when
//! one of them reached the "alert acknowledgement set" callsite first, its thread (no
//! subscriber) cached the callsite as never-interesting, and this test's capture missed the
//! line (about 1 run in 3). Alone in a process, the only thread that reaches these callsites
//! is this test's, with the capture in place.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::fleet::events::Reauth;
use elasticpro_core::zbx_link::ServerZbx;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use support::{TempDir, TestServer};

const PASSWORD: &str = "correct-horse-battery";

fn hosted(dir: &TempDir) -> Arc<Core> {
    let server = ServerZbx { trusted_proxies: Some(vec!["127.0.0.1/32".into()]), ..Default::default() };
    Core::new_with_server_zbx(Some(dir.0.clone()), Edition::Hosted, 1, server)
}

async fn admin_session(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn admin(c: &Arc<Core>, s: &str, mut msg: Value) -> Value {
    msg["session"] = json!(s);
    c.handle(msg).await
}

fn ip(s: &str) -> Option<IpAddr> {
    Some(s.parse().unwrap())
}

/// The audit lines written while the test runs (JSON, as the bridge writes them).
#[derive(Clone, Default)]
struct Lines(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Lines {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn acknowledgements_are_shared_audited_and_cut_to_what_the_caller_sees() {
    let dir = TempDir::new("play-acks");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let es = TestServer::with(|_| (200, r#"{"cluster_name":"test","status":"green"}"#.into())).await;
    let r = admin(&c, &s, json!({ "type": "PRIME", "readOnly": true, "clusters": [
        { "id": "c1", "url": es.url() }, { "id": "c2", "url": es.url() } ] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let lines = Lines::default();
    let sub = tracing_subscriber::fmt().json().with_writer({ let l = lines.clone(); move || l.clone() })
        .with_max_level(tracing::Level::INFO).finish();
    let _guard = tracing::subscriber::set_default(sub);

    let set = admin(&c, &s, json!({ "type": "ACK_SET", "key": "c1:disk:hot", "note": "vendor ticket 4412",
        "record": { "acked": true, "ackedAt": 1, "ackedBy": "someone", "notes": [] } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["ack"]["by"], json!("Admin"));
    assert_eq!(set["ack"]["record"]["ackedBy"], json!("Admin"), "the server says who");
    assert_eq!(admin(&c, &s, json!({ "type": "ACK_SET", "key": "c2:disk" })).await["ok"], json!(true));
    let list = admin(&c, &s, json!({ "type": "ACK_LIST" })).await;
    assert_eq!(list["acks"].as_object().unwrap().len(), 2, "{list}");
    // It is in the file, not in a browser.
    assert!(std::fs::read_to_string(dir.join("acks.json")).unwrap().contains("c1:disk:hot"));

    // A display link for c1 sees c1's acknowledgement only.
    let made = admin(&c, &s, json!({ "type": "PLAY_LINK_CREATE", "name": "c1 wall", "clusters": ["c1"] })).await;
    assert_eq!(made["ok"], json!(true), "{made}");
    let secret = made["secret"].as_str().unwrap().to_string();
    let ex = c.handle_as_from_at(json!({ "type": "PLAY_EXCHANGE", "secret": secret }), None, Reauth::None, ip("10.0.0.1")).await;
    let tok = ex["session"].as_str().unwrap().to_string();
    let caller = c.caller_for_session(&tok);
    let seen = c.handle_as_from_at(json!({ "type": "ACK_LIST", "session": tok }), caller, Reauth::Session(tok.clone()), ip("10.0.0.1")).await;
    assert_eq!(seen["acks"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["c1:disk:hot"], "{seen}");

    let clr = admin(&c, &s, json!({ "type": "ACK_CLEAR", "key": "c1:disk:hot" })).await;
    assert_eq!(clr["ok"], json!(true), "{clr}");
    assert_eq!(admin(&c, &s, json!({ "type": "ACK_LIST" })).await["acks"].as_object().unwrap().len(), 1);
    assert_eq!(admin(&c, &s, json!({ "type": "ACK_SET", "key": "" })).await["kind"], json!("bad_request"));

    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    let audit: Vec<&str> = text.lines().filter(|l| l.contains("\"target\":\"audit\"")).collect();
    assert!(audit.iter().any(|l| l.contains("alert acknowledgement set") && l.contains("c1:disk:hot") && l.contains("\"user\":\"Admin\"")), "{text}");
    assert!(audit.iter().any(|l| l.contains("alert acknowledgement cleared") && l.contains("c1:disk:hot")), "{text}");
    assert!(!text.contains("vendor ticket 4412"), "a note is counted, not copied into the log");
    assert!(!text.contains(&secret) && !text.contains(PASSWORD), "no secret is ever logged");
}
