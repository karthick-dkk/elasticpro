//! What the core puts on the wire, and how it names what went wrong.
//!
//! These run against a real loopback socket, so "the guard blocks it" is proved the
//! only way that means anything: the server never sees a connection.

mod support;

use elasticpro_core::Core;
use serde_json::json;
use support::{dead_port, TempDir, TestServer};

fn core(dir: &TempDir) -> std::sync::Arc<Core> {
    Core::new(Some(dir.0.clone()), elasticpro_core::auth::Edition::Portable)
}

async fn primed(dir: &TempDir, url: &str, read_only: bool) -> std::sync::Arc<Core> {
    let c = core(dir);
    c.handle(json!({
        "type": "PRIME",
        "clusters": [{ "id": "es", "url": url }],
        "readOnly": read_only,
    }))
    .await;
    c
}

/* ---------------------------------- happy path ---------------------------------- */

#[tokio::test]
async fn a_get_reaches_the_cluster_and_comes_back_parsed() {
    let dir = TempDir::new("get");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;

    let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/_cluster/health" })).await;

    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(res["status"], json!(200));
    assert_eq!(res["kind"], json!("ok"));
    assert_eq!(res["json"]["status"], json!("green"), "the body must arrive parsed, not as text");
    assert_eq!(res["url"], json!(format!("{}/_cluster/health", srv.url())));

    let hit = srv.last_hit().expect("the server saw the request");
    assert_eq!(hit.method, "GET");
    assert_eq!(hit.path, "/_cluster/health");
    assert_eq!(hit.header("accept"), Some("application/json"));
    assert!(hit.header("user-agent").unwrap().starts_with("ElasticPro-Desktop/"));
}

#[tokio::test]
async fn a_path_without_a_leading_slash_still_addresses_the_cluster_root() {
    let dir = TempDir::new("slash");
    let srv = TestServer::start().await;
    let c = primed(&dir, &format!("{}/", srv.url()), true).await;

    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "_cat/indices" })).await;

    assert_eq!(srv.last_hit().unwrap().path, "/_cat/indices", "no doubled or missing slash");
}

#[tokio::test]
async fn a_non_json_body_is_handed_back_as_text_rather_than_dropped() {
    let dir = TempDir::new("text");
    let srv = TestServer::with(|_| (200, "not json at all".into())).await;
    let c = primed(&dir, &srv.url(), true).await;

    let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    assert_eq!(res["ok"], json!(true));
    assert!(res["json"].is_null());
    assert_eq!(res["text"], json!("not json at all"));
}

#[tokio::test]
async fn an_http_error_keeps_its_status_and_body() {
    let dir = TempDir::new("401");
    let srv = TestServer::with(|_| (401, r#"{"error":"security_exception"}"#.into())).await;
    let c = primed(&dir, &srv.url(), true).await;

    let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["status"], json!(401));
    assert_eq!(res["kind"], json!("http_error"), "a 401 is an answer, not a transport failure");
    assert_eq!(res["json"]["error"], json!("security_exception"));
}

/* ------------------------------ the read-only guard ------------------------------ */

#[tokio::test]
async fn a_blocked_write_never_opens_a_socket() {
    let dir = TempDir::new("guard");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;

    for (method, path) in [("DELETE", "/logstash-2026.01.01"), ("PUT", "/x/_doc/1"), ("POST", "/x/_doc")] {
        let res = c
            .handle(json!({ "type": "ES", "clusterId": "es", "method": method, "path": path }))
            .await;
        assert_eq!(res["ok"], json!(false), "{method} {path} must be refused");
        assert_eq!(res["kind"], json!("blocked_readonly"), "{method} {path}");
        assert!(res["message"].as_str().unwrap().contains(method));
    }

    assert_eq!(srv.connections(), 0, "the guard must refuse before a socket is opened, not after");
}

#[tokio::test]
async fn search_family_posts_are_allowed_through_with_their_body() {
    let dir = TempDir::new("search");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    let body = r#"{"query":{"match_all":{}}}"#;

    let res = c
        .handle(json!({ "type": "ES", "clusterId": "es", "method": "POST",
                        "path": "/logstash-*/_search", "body": body }))
        .await;

    assert_eq!(res["ok"], json!(true), "{res}");
    let hit = srv.last_hit().expect("the search reached the cluster");
    assert_eq!(hit.method, "POST");
    assert_eq!(hit.body, body);
    assert_eq!(hit.header("content-type"), Some("application/json"));
}

#[tokio::test]
async fn the_ndjson_endpoints_are_labelled_by_endpoint_not_by_body_shape() {
    // Every _msearch / _bulk body opens with a `{` header line, so sniffing the first
    // character labelled them application/json and Elasticsearch refused them.
    let dir = TempDir::new("ndjson");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), false).await;
    let ndjson = "{}\n{\"query\":{\"match_all\":{}}}\n";

    for path in ["/_msearch", "/logstash-*/_msearch", "/_msearch?pretty", "/_bulk", "/x/_bulk"] {
        c.handle(json!({ "type": "ES", "clusterId": "es", "method": "POST", "path": path, "body": ndjson })).await;
        assert_eq!(
            srv.last_hit().unwrap().header("content-type"),
            Some("application/x-ndjson"),
            "{path} must be sent as ndjson"
        );
    }

    // an ordinary search is still json
    c.handle(json!({ "type": "ES", "clusterId": "es", "method": "POST", "path": "/x/_search",
                     "body": r#"{"query":{"match_all":{}}}"# }))
        .await;
    assert_eq!(srv.last_hit().unwrap().header("content-type"), Some("application/json"));

    // and an index that merely *contains* the word is not an ndjson endpoint
    c.handle(json!({ "type": "ES", "clusterId": "es", "method": "POST", "path": "/_bulky/_doc",
                     "body": r#"{"a":1}"# }))
        .await;
    assert_eq!(srv.last_hit().unwrap().header("content-type"), Some("application/json"));
}

#[tokio::test]
async fn turning_read_only_off_lets_a_write_through() {
    let dir = TempDir::new("rw");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), false).await;

    let res = c
        .handle(json!({ "type": "ES", "clusterId": "es", "method": "DELETE", "path": "/old-index" }))
        .await;

    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(srv.last_hit().unwrap().method, "DELETE");
}

#[tokio::test]
async fn a_search_lookalike_path_does_not_smuggle_a_write_past_the_guard() {
    let dir = TempDir::new("smuggle");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;

    // an index literally named "_search-ish", and a query string that mentions _search
    for path in ["/my_search_index/_doc", "/x/_doc?pretty=_search"] {
        let res = c
            .handle(json!({ "type": "ES", "clusterId": "es", "method": "POST", "path": path }))
            .await;
        assert_eq!(res["kind"], json!("blocked_readonly"), "{path} slipped past the guard");
    }
    assert_eq!(srv.connections(), 0);
}

/* -------------------------------- the credential -------------------------------- */

#[tokio::test]
async fn the_primed_credential_is_sent_and_nothing_else_is() {
    let dir = TempDir::new("auth");
    let srv = TestServer::start().await;
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "es", "url": srv.url(), "authHeader": "Basic ZWxhc3RpYzpwdw==" }
    ]}))
    .await;

    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    let hit = srv.last_hit().unwrap();
    assert_eq!(hit.header("authorization"), Some("Basic ZWxhc3RpYzpwdw=="));
    assert_eq!(hit.header("cookie"), None, "no cookie jar should ride along");
}

#[tokio::test]
async fn an_empty_auth_override_sends_no_credential_at_all() {
    // the UI's diagnostic probe: "does this cluster answer without a credential?"
    let dir = TempDir::new("noauth");
    let srv = TestServer::start().await;
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "es", "url": srv.url(), "authHeader": "Basic ZWxhc3RpYzpwdw==" }
    ]}))
    .await;

    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/", "authHeader": "" })).await;

    assert_eq!(srv.last_hit().unwrap().header("authorization"), None);
}

#[tokio::test]
async fn forget_drops_the_credential_from_the_next_request() {
    let dir = TempDir::new("forget");
    let srv = TestServer::start().await;
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "es", "url": srv.url(), "authHeader": "Basic c2VjcmV0" }
    ]}))
    .await;
    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;
    assert!(srv.last_hit().unwrap().header("authorization").is_some());

    c.handle(json!({ "type": "FORGET" })).await;
    let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    assert_eq!(res["kind"], json!("no_creds"), "after FORGET the cluster is unknown again");
    assert_eq!(srv.hits().len(), 1, "no second request went out");
}

/* ---------------------------- naming what went wrong ---------------------------- */

#[tokio::test]
async fn a_closed_port_is_called_a_refused_connection_not_a_certificate_problem() {
    let dir = TempDir::new("refused");
    let port = dead_port().await;
    let c = primed(&dir, &format!("http://127.0.0.1:{port}"), true).await;

    let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("connection_refused"), "{res}");
    assert!(res["help"].as_str().unwrap().contains("Not a certificate problem"));
    assert!(res["tookMs"].as_u64().is_some());
}

#[tokio::test]
async fn a_server_that_never_answers_is_called_a_timeout() {
    let dir = TempDir::new("timeout");
    let srv = TestServer::stall().await;
    let c = primed(&dir, &srv.url(), true).await;

    let res = c
        .handle(json!({ "type": "ES", "clusterId": "es", "path": "/", "timeoutMs": 400 }))
        .await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("timeout"), "{res}");
    assert_eq!(srv.connections(), 1, "it did connect — the answer never came");
}

#[tokio::test]
async fn a_name_that_cannot_resolve_is_called_dns() {
    let dir = TempDir::new("dns");
    // .invalid is reserved by RFC 2606 and must never resolve
    let c = primed(&dir, "http://cluster.invalid:9200", true).await;

    let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("dns"), "{res}");
    assert!(res["help"].as_str().unwrap().contains("jump host"), "the help must point at the via: case");
}

#[tokio::test]
async fn a_bad_method_is_refused_before_it_reaches_the_wire() {
    let dir = TempDir::new("badmethod");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), false).await;

    let res = c
        .handle(json!({ "type": "ES", "clusterId": "es", "method": "GET INDEX", "path": "/" }))
        .await;

    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("bad_method"), "{res}");
    assert_eq!(srv.connections(), 0);
}

#[tokio::test]
async fn every_failure_carries_a_kind_the_ui_can_switch_on() {
    let dir = TempDir::new("kinds");
    let port = dead_port().await;
    let c = primed(&dir, &format!("http://127.0.0.1:{port}"), true).await;

    for msg in [
        json!({ "type": "ES", "clusterId": "es", "path": "/" }),
        json!({ "type": "ES", "clusterId": "es", "method": "DELETE", "path": "/x" }),
        json!({ "type": "ES", "clusterId": "ghost", "path": "/" }),
    ] {
        let res = c.handle(msg.clone()).await;
        assert_eq!(res["ok"], json!(false), "{msg}");
        let kind = res["kind"].as_str().unwrap_or("");
        assert!(!kind.is_empty(), "no kind on {msg} -> {res}");
        assert!(!res["message"].as_str().unwrap_or("").is_empty(), "no message on {msg}");
    }
}

/* ------------------------------- client identity -------------------------------- */

#[tokio::test]
async fn host_key_is_the_address_a_pin_is_recorded_against() {
    use elasticpro_core::http::host_key;
    assert_eq!(host_key("https://es.internal:9200/"), "es.internal:9200");
    assert_eq!(host_key("https://es.internal"), "es.internal:443", "the port a pin needs is the real one");
    assert_eq!(host_key("http://es.internal"), "es.internal:80");
    assert_eq!(host_key("https://10.0.0.1:9243/some/path"), "10.0.0.1:9243", "the path is not part of the identity");
}

#[tokio::test]
async fn re_priming_a_cluster_at_a_new_address_does_not_reuse_the_old_client() {
    let dir = TempDir::new("repin");
    let a = TestServer::start().await;
    let b = TestServer::start().await;
    let c = primed(&dir, &a.url(), true).await;
    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "es", "url": b.url() }] })).await;
    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    assert_eq!(a.hits().len(), 1);
    assert_eq!(b.hits().len(), 1, "the second request must go to the new address");
}

/* ------------------------- the operator write unlock ------------------------- */

#[tokio::test]
async fn a_ui_action_can_write_only_when_the_operator_has_unlocked_the_session() {
    let dir = TempDir::new("unlock");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    let del = json!({ "type": "ES", "clusterId": "es", "method": "DELETE",
                      "path": "/logstash-2026.01.01", "allowWrites": true });

    // asking is not enough on its own
    let res = c.handle(del.clone()).await;
    assert_eq!(res["kind"], json!("blocked_readonly"), "a page must not unlock itself");
    assert_eq!(srv.connections(), 0);

    let u = c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;
    assert_eq!(u["ok"], json!(true));
    assert_eq!(u["writesUnlocked"], json!(true));

    let res = c.handle(del.clone()).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(srv.last_hit().unwrap().method, "DELETE");

    // and it can be locked again
    c.handle(json!({ "type": "WRITE_UNLOCK", "on": false })).await;
    assert_eq!(c.handle(del).await["kind"], json!("blocked_readonly"));
}

#[tokio::test]
async fn an_unlocked_session_does_not_let_the_rest_of_the_app_write() {
    let dir = TempDir::new("unlock2");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;

    // exactly the request a background refresh would make: no allowWrites flag
    let res = c
        .handle(json!({ "type": "ES", "clusterId": "es", "method": "DELETE", "path": "/logstash-2026.01.01" }))
        .await;

    assert_eq!(res["kind"], json!("blocked_readonly"), "only a request the operator asked for may write");
    assert_eq!(srv.connections(), 0);
}

#[tokio::test]
async fn every_method_an_operator_may_type_reaches_the_cluster_once_unlocked() {
    let dir = TempDir::new("methods");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;

    for (method, path) in [
        ("GET", "/_cluster/health"),
        ("HEAD", "/logstash-2026.01.01"),
        ("POST", "/_slm/policy/daily/_execute"),
        ("PUT", "/_cluster/settings"),
        ("DELETE", "/logstash-2026.01.01"),
        ("PATCH", "/_x"),
    ] {
        let res = c
            .handle(json!({ "type": "ES", "clusterId": "es", "method": method, "path": path,
                            "allowWrites": true, "body": "{}" }))
            .await;
        assert_eq!(res["ok"], json!(true), "{method} {path} -> {res}");
        assert_eq!(srv.last_hit().unwrap().method, method);
    }
}

#[tokio::test]
async fn the_unlock_is_reported_by_ping_and_dropped_by_forget() {
    let dir = TempDir::new("unlockstate");
    let c = core(&dir);
    assert_eq!(c.handle(json!({ "type": "PING" })).await["writesUnlocked"], json!(false),
               "a session must always start locked");

    c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;
    assert_eq!(c.handle(json!({ "type": "PING" })).await["writesUnlocked"], json!(true));

    c.handle(json!({ "type": "FORGET" })).await;
    assert_eq!(c.handle(json!({ "type": "PING" })).await["writesUnlocked"], json!(false),
               "FORGET means forget this too");
}

#[tokio::test]
async fn the_unlock_is_never_written_to_disk() {
    let dir = TempDir::new("unlockdisk");
    let c = core(&dir);
    c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;
    c.handle(json!({ "type": "TRUST_CERT", "host": "a:9200", "sha256": "AB" })).await;

    // a fresh Core over the same data dir starts locked again
    let c2 = core(&dir);
    assert_eq!(c2.handle(json!({ "type": "PING" })).await["writesUnlocked"], json!(false));

    let text = std::fs::read_to_string(dir.join("pins.json")).expect("pins.json");
    assert!(!text.contains("writesUnlocked"), "the unlock must not be persisted anywhere:\n{text}");
}

#[tokio::test]
async fn snapshot_management_is_refused_until_the_operator_unlocks() {
    // Exactly the requests the Snapshots page makes.
    let dir = TempDir::new("snapmgmt");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;
    let actions = [
        ("PUT", "/_snapshot/daily/manual-2026.09.09-120000?wait_for_completion=false"),
        ("DELETE", "/_snapshot/daily/manual-2026.09.09-120000"),
        ("POST", "/_snapshot/daily/manual-2026.09.09-120000/_restore?wait_for_completion=false"),
        ("PUT", "/_snapshot/daily?verify=true"),
        ("DELETE", "/_snapshot/daily"),
        ("POST", "/_snapshot/daily/_verify"),
        ("POST", "/_snapshot/daily/_cleanup"),
        ("POST", "/_slm/policy/nightly/_execute"),
        ("DELETE", "/logstash-2026.01.01"),
    ];

    for (method, path) in actions {
        let res = c
            .handle(json!({ "type": "ES", "clusterId": "es", "method": method, "path": path, "allowWrites": true }))
            .await;
        assert_eq!(res["kind"], json!("blocked_readonly"), "{method} {path} must need the unlock");
    }
    assert_eq!(srv.connections(), 0, "not one of them reached a socket");

    c.handle(json!({ "type": "WRITE_UNLOCK", "on": true })).await;
    for (method, path) in actions {
        let res = c
            .handle(json!({ "type": "ES", "clusterId": "es", "method": method, "path": path, "allowWrites": true }))
            .await;
        assert_eq!(res["ok"], json!(true), "{method} {path} -> {res}");
    }
    assert_eq!(srv.hits().len(), actions.len());
}

#[tokio::test]
async fn reading_snapshots_never_needs_the_unlock() {
    // The page must render fully while the session is locked; only acting needs writes.
    let dir = TempDir::new("snapread");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;

    for path in [
        "/_snapshot",
        "/_snapshot/daily/_all?ignore_unavailable=true&verbose=true",
        "/_snapshot/daily/manual-2026.09.09-120000?ignore_unavailable=true",
        "/_cat/snapshots/daily?format=json",
        "/_slm/policy",
        "/_slm/stats",
        "/_cat/indices/*?format=json",
    ] {
        let res = c.handle(json!({ "type": "ES", "clusterId": "es", "path": path })).await;
        assert_eq!(res["ok"], json!(true), "{path} -> {res}");
    }
}

/* ------------------------ how hard are we hitting the cluster ------------------------ */

#[tokio::test]
async fn requests_to_each_cluster_are_counted_over_the_window() {
    let dir = TempDir::new("reqcount");
    let a = TestServer::start().await;
    let b = TestServer::start().await;
    let c = core(&dir);
    c.handle(json!({ "type": "PRIME", "clusters": [
        { "id": "a", "url": a.url() }, { "id": "b", "url": b.url() }
    ]}))
    .await;

    for _ in 0..3 {
        c.handle(json!({ "type": "ES", "clusterId": "a", "path": "/" })).await;
    }
    c.handle(json!({ "type": "ES", "clusterId": "b", "path": "/" })).await;

    let st = c.handle(json!({ "type": "REQUEST_STATS" })).await;
    assert_eq!(st["ok"], json!(true));
    assert_eq!(st["requests"]["windowSec"], json!(300));
    assert_eq!(st["requests"]["clusters"]["a"]["last5m"], json!(3), "{st}");
    assert_eq!(st["requests"]["clusters"]["b"]["last5m"], json!(1), "{st}");
    assert!(st["requests"]["clusters"]["a"]["perMinute"].as_f64().unwrap() > 0.0);

    // PING carries the same figure, so the UI needs no extra round trip.
    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["requests"]["clusters"]["a"]["last5m"], json!(3));
}

#[tokio::test]
async fn a_request_the_guard_blocked_is_not_counted_as_load() {
    // It never reached a socket, so it is not load on the cluster.
    let dir = TempDir::new("reqblocked");
    let srv = TestServer::start().await;
    let c = primed(&dir, &srv.url(), true).await;

    c.handle(json!({ "type": "ES", "clusterId": "es", "method": "DELETE", "path": "/x" })).await;
    c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;

    let st = c.handle(json!({ "type": "REQUEST_STATS" })).await;
    assert_eq!(st["requests"]["clusters"]["es"]["last5m"], json!(1), "only the GET counts: {st}");
    assert_eq!(srv.connections(), 1);
}
