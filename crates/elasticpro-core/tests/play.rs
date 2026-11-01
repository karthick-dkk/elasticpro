//! Play (docs/PLAY.md, "Core (Rust)") through the real message API: display links and what
//! their sessions may do, node-name history from the fleet poller, shared acknowledgements,
//! the shared measurement cache and the settings.

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
    // The trusted proxy is loopback, as nginx in front of the core.
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

/// A cluster that answers what Play and the poller ask: health, nodes (the names `names`
/// holds), and a search.
async fn cluster(names: Arc<Mutex<Vec<&'static str>>>) -> TestServer {
    TestServer::with(move |h| {
        let p = h.path.as_str();
        if p.starts_with("/_cat/nodes") {
            let rows: Vec<Value> = names.lock().unwrap().iter().map(|n| json!({ "name": n, "ip": "10.0.0.1" })).collect();
            return (200, Value::Array(rows).to_string());
        }
        if p.starts_with("/_cat/allocation") {
            return (200, "[]".into());
        }
        if p.contains("_search") || p.contains("_field_caps") {
            return (200, r#"{"hits":{"total":{"value":0},"hits":[]}}"#.into());
        }
        (200, r#"{"cluster_name":"test","status":"green"}"#.into())
    })
    .await
}

async fn prime(c: &Arc<Core>, s: &str, es: &TestServer) {
    let r = admin(c, s, json!({ "type": "PRIME", "readOnly": true, "clusters": [
        { "id": "c1", "url": es.url(), "logIndexPattern": "logs-*" }, { "id": "c2", "url": es.url(), "logIndexPattern": "logs-*" } ] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
}

fn ip(s: &str) -> Option<IpAddr> {
    Some(s.parse().unwrap())
}

/// The log-delay measurement's search body, as ui/js/core/log-delay.js buildSearchBody builds it.
fn delay_body(size: u64) -> String {
    json!({
        "size": 0,
        "query": { "bool": { "filter": [{ "range": { "@timestamp": { "gte": "now-24h", "lte": "now", "format": "strict_date_optional_time" } } }] } },
        "aggs": { "devices": {
            "terms": { "field": "host.keyword", "size": size, "order": { "_count": "desc" } },
            "aggs": { "latest": { "top_hits": { "size": 1, "sort": [{ "@timestamp": { "order": "desc" } }], "_source": ["@timestamp"] } } },
        } },
    }).to_string()
}

/// One message as the TV holding `token` sends it, from `source`.
async fn as_display(c: &Arc<Core>, token: &str, mut msg: Value, source: Option<IpAddr>) -> Value {
    msg["session"] = json!(token);
    let caller = c.caller_for_session(token);
    c.handle_as_from_at(msg, caller, Reauth::Session(token.to_string()), source).await
}

async fn exchange(c: &Arc<Core>, secret: &str, source: Option<IpAddr>) -> Value {
    c.handle_as_from_at(json!({ "type": "PLAY_EXCHANGE", "secret": secret }), None, Reauth::None, source).await
}

async fn create(c: &Arc<Core>, s: &str, body: Value) -> (String, String) {
    let mut msg = body;
    msg["type"] = json!("PLAY_LINK_CREATE");
    let r = admin(c, s, msg).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let secret = r["secret"].as_str().unwrap().to_string();
    assert!(r["link"]["url"].as_str().unwrap().ends_with(&format!("/#/play?display={secret}")), "{r}");
    (r["link"]["id"].as_str().unwrap().to_string(), secret)
}

/* -------------------------------- display links -------------------------------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_display_link_shows_play_and_nothing_else() {
    let dir = TempDir::new("play-link");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let es = cluster(Arc::new(Mutex::new(vec!["n1"]))).await;
    prime(&c, &s, &es).await;
    let (id, secret) = create(&c, &s, json!({ "name": "Lobby TV", "clusters": ["c1"] })).await;

    let ex = exchange(&c, &secret, ip("10.1.1.1")).await;
    assert_eq!(ex["ok"], json!(true), "{ex}");
    assert_eq!(ex["caller"]["name"], json!("display:Lobby TV"));
    assert_eq!(ex["caller"]["playOnly"], json!(true));
    assert_eq!(ex["caller"]["role"], json!("user"));
    let tok = ex["session"].as_str().unwrap().to_string();
    let from = ip("10.1.1.1");

    // The reads Play is made of.
    let st = as_display(&c, &tok, json!({ "type": "FLEET_STATE" }), from).await;
    assert_eq!(st["ok"], json!(true), "{st}");
    assert_eq!(st["clusterIds"], json!(["c1"]), "only the link's clusters: {st}");
    let ps = as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), from).await;
    assert_eq!(ps["ok"], json!(true), "{ps}");
    assert_eq!(ps["zoom"], json!(1.0));
    let search = as_display(&c, &tok, json!({ "type": "ES", "clusterId": "c1", "method": "POST",
        "path": "/logs-%2A/_search?ignore_unavailable=true&allow_no_indices=true", "body": delay_body(500) }), from).await;
    assert_eq!(search["ok"], json!(true), "the delay measurement's search: {search}");
    let caps = as_display(&c, &tok, json!({ "type": "ES", "clusterId": "c1", "method": "GET", "path": "/logs-*/_field_caps?fields=host" }), from).await;
    assert_eq!(caps["ok"], json!(true), "{caps}");
    // Each cluster's type and ULM: without it every CI / DI cluster would read as On-Prem on the wall.
    let meta = as_display(&c, &tok, json!({ "type": "CLUSTER_META_GET" }), from).await;
    assert_eq!(meta["ok"], json!(true), "{meta}");

    // Everything else is refused, with the one reason.
    for msg in [
        json!({ "type": "CONFIG_WRITE", "path": "/tmp/x", "text": "x" }),
        json!({ "type": "CREDENTIAL_SET", "id": "*", "username": "u", "password": "p" }),
        json!({ "type": "CREDENTIAL_STATUS" }),
        json!({ "type": "WRITE_UNLOCK", "on": true }),
        json!({ "type": "ES", "clusterId": "c1", "method": "DELETE", "path": "/logs-1", "allowWrites": true }),
        json!({ "type": "ES", "clusterId": "c1", "method": "PUT", "path": "/logs-1/_search" }),
        json!({ "type": "ES", "clusterId": "c1", "method": "GET", "path": "/_cat/indices" }),
        json!({ "type": "ES", "clusterId": "c1", "method": "POST", "path": "/logs-*/_search?scroll=1m" }),
        // Anything shaped like a search that is not the measurement: every index, hidden ones too;
        // documents rather than counts; another pattern.
        json!({ "type": "ES", "clusterId": "c1", "method": "GET", "path": "/*,.*/_search?expand_wildcards=all", "body": delay_body(500) }),
        json!({ "type": "ES", "clusterId": "c1", "method": "POST", "path": "/logs-*/_search", "body": json!({ "size": 10000, "query": { "match_all": {} } }).to_string() }),
        json!({ "type": "ES", "clusterId": "c1", "method": "POST", "path": "/logs-*/_search", "body": "{}" }),
        json!({ "type": "ES", "clusterId": "c1", "method": "POST", "path": "/.security/_search", "body": delay_body(500) }),
        json!({ "type": "CLUSTER_META_SET", "clusterId": "c1", "meta": { "type": "ci" } }),
        json!({ "type": "ACK_SET", "key": "c1:disk" }),
        json!({ "type": "PLAY_CONFIG_GET" }),
        json!({ "type": "PLAY_LINK_LIST" }),
        json!({ "type": "SILENCE_SET", "scope": "cluster", "target": "c1" }),
        json!({ "type": "PLAY_SHARE_PUT", "kind": "repoSize", "clusterId": "c1", "measuredAt": 1, "data": {} }),
        json!({ "type": "LOGIN", "name": "Admin", "password": PASSWORD }),
    ] {
        let r = as_display(&c, &tok, msg.clone(), from).await;
        assert_eq!((r["ok"].clone(), r["kind"].clone()), (json!(false), json!("forbidden")), "{msg} -> {r}");
        assert!(r["message"].as_str().unwrap().starts_with("a display link only shows Play"), "{msg} -> {r}");
    }
    // A cluster the link does not name is not its, even for a search.
    let other = as_display(&c, &tok, json!({ "type": "ES", "clusterId": "c2", "method": "POST", "path": "/logs-*/_search", "body": delay_body(500) }), from).await;
    assert_eq!(other["kind"], json!("forbidden"), "{other}");
    assert!(!es.hits().iter().any(|h| h.method == "DELETE" || h.path.starts_with("/_cat/indices") || h.path.contains("expand_wildcards")
        || h.path.starts_with("/.security")), "nothing refused reached the cluster");

    // Its own zoom is kept for it.
    let z = as_display(&c, &tok, json!({ "type": "PLAY_ZOOM_SET", "zoom": 1.25 }), from).await;
    assert_eq!(z["zoom"], json!(1.25), "{z}");
    assert_eq!(as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), from).await["zoom"], json!(1.25));
    // Unless the administrator fixes it.
    let set = admin(&c, &s, json!({ "type": "PLAY_LINK_SET", "id": id, "settings": { "zoom": 0.9, "sound": "chime",
        "slides": [{ "id": "alerts", "show": true, "dwellSec": 30 }, { "id": "fleet", "show": false, "dwellSec": 20 }] } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    let ps = as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), from).await;
    assert_eq!(ps["zoom"], json!(0.9));
    assert_eq!(ps["settings"]["display"]["slides"][0]["id"], json!("alerts"));

    // The list says when and from where, never the secret.
    let list = admin(&c, &s, json!({ "type": "PLAY_LINK_LIST" })).await;
    let l = &list["links"][0];
    assert_eq!(l["lastSeen"]["from"], json!("10.1.1.1"), "{list}");
    assert_eq!(l["sessions"], json!(1));
    assert_eq!(l["expires"], json!("permanent"), "permanent is the default");
    assert!(l.get("url").is_none() && !list.to_string().contains(&secret), "{list}");
    assert!(!std::fs::read_to_string(dir.join("play-links.json")).unwrap().contains(&secret), "only a hash is kept");
}

#[tokio::test]
async fn allow_from_is_decided_on_the_address_the_trusted_proxy_names() {
    let dir = TempDir::new("play-allow");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let (_, secret) = create(&c, &s, json!({ "name": "NOC wall", "allowFrom": ["10.0.0.0/24"] })).await;
    let link = c.zabbix_link();
    let loopback = Some("127.0.0.1".parse::<IpAddr>().unwrap());
    // Through the proxy: the X-Real-IP it sets is the address.
    let outside = link.effective_source(Some("10.9.9.9"), loopback);
    let inside = link.effective_source(Some("10.0.0.7"), loopback);
    // Not through the proxy: a header anyone can send is not believed.
    let spoofed = link.effective_source(Some("10.0.0.7"), ip("192.168.5.5"));
    assert_eq!(spoofed, ip("192.168.5.5"));

    assert_eq!(exchange(&c, &secret, outside).await["kind"], json!("forbidden"));
    assert_eq!(exchange(&c, &secret, spoofed).await["kind"], json!("forbidden"));
    assert_eq!(exchange(&c, &secret, None).await["kind"], json!("forbidden"), "no known address is not an allowed one");
    let ex = exchange(&c, &secret, inside).await;
    assert_eq!(ex["ok"], json!(true), "{ex}");
    let tok = ex["session"].as_str().unwrap().to_string();
    assert_eq!(as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), inside).await["ok"], json!(true));
    // The session is refused from anywhere else, however it got there.
    let r = as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), outside).await;
    assert_eq!((r["kind"].clone(), r["playOnly"].clone()), (json!("forbidden"), json!(true)), "{r}");
    assert_eq!(as_display(&c, &tok, json!({ "type": "FLEET_STATE" }), spoofed).await["kind"], json!("forbidden"));
}

#[tokio::test]
async fn revoking_a_link_ends_its_sessions_at_once() {
    let dir = TempDir::new("play-revoke");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let (id, secret) = create(&c, &s, json!({ "name": "Ops TV" })).await;
    let tok = exchange(&c, &secret, ip("10.0.0.1")).await["session"].as_str().unwrap().to_string();
    assert!(c.caller_for_session(&tok).is_some());
    let r = admin(&c, &s, json!({ "type": "PLAY_LINK_REVOKE", "id": id })).await;
    assert_eq!((r["ok"].clone(), r["sessionsEnded"].clone()), (json!(true), json!(1)), "{r}");
    assert!(c.caller_for_session(&tok).is_none(), "the TV is nobody now");
    assert_eq!(as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), ip("10.0.0.1")).await["kind"], json!("unauthenticated"));
    assert_eq!(exchange(&c, &secret, ip("10.0.0.1")).await["kind"], json!("bad_credentials"));
    assert_eq!(admin(&c, &s, json!({ "type": "PLAY_LINK_REVOKE", "id": id })).await["kind"], json!("not_found"));
}

#[tokio::test]
async fn an_expiring_link_stops_working_when_it_expires_and_a_permanent_one_does_not() {
    let dir = TempDir::new("play-expiry");
    let (tok_exp, tok_perm, secret_exp) = {
        let c = hosted(&dir);
        let s = admin_session(&c).await;
        let (_, secret_exp) = create(&c, &s, json!({ "name": "Temp TV", "expires": 1 })).await;
        let (_, secret_perm) = create(&c, &s, json!({ "name": "Wall TV", "expires": "permanent" })).await;
        let list = admin(&c, &s, json!({ "type": "PLAY_LINK_LIST" })).await;
        let by_name = |n: &str| list["links"].as_array().unwrap().iter().find(|l| l["name"] == json!(n)).unwrap().clone();
        let day = by_name("Temp TV")["expiresAt"].as_u64().unwrap() - elasticpro_core::fleet::now_ms();
        assert!((86_000_000..=86_400_000).contains(&day), "one day: {day}");
        assert_eq!(by_name("Wall TV")["expiresAt"], Value::Null);
        let e = exchange(&c, &secret_exp, ip("10.0.0.1")).await;
        let p = exchange(&c, &secret_perm, ip("10.0.0.1")).await;
        (e["session"].as_str().unwrap().to_string(), p["session"].as_str().unwrap().to_string(), secret_exp)
    };
    // A day passes: the expiry is moved into the past in the file, and the core restarts.
    let path = dir.join("play-links.json");
    let mut links: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for l in links.as_array_mut().unwrap() {
        if l["name"] == json!("Temp TV") {
            l["expiresAt"] = json!(1);
        }
    }
    std::fs::write(&path, links.to_string()).unwrap();
    let c = hosted(&dir);
    assert!(c.caller_for_session(&tok_exp).is_none(), "the expired link's TV is nobody");
    assert_eq!(exchange(&c, &secret_exp, ip("10.0.0.1")).await["kind"], json!("bad_credentials"));
    assert!(c.caller_for_session(&tok_perm).is_some(), "the permanent one, and its session, survive a restart");
    assert_eq!(as_display(&c, &tok_perm, json!({ "type": "PLAY_STATE" }), ip("10.0.0.1")).await["ok"], json!(true));
}

#[tokio::test]
async fn links_are_hosted_only_and_need_a_name_and_valid_limits() {
    let dir = TempDir::new("play-desktop");
    let d = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    assert_eq!(d.handle(json!({ "type": "PLAY_LINK_CREATE", "name": "x" })).await["kind"], json!("unsupported"));
    assert_eq!(d.handle(json!({ "type": "PLAY_EXCHANGE", "secret": "x" })).await["kind"], json!("unsupported"));
    let dir2 = TempDir::new("play-create");
    let c = hosted(&dir2);
    let s = admin_session(&c).await;
    for bad in [json!({ "name": "" }), json!({ "name": "a", "clusters": [] }), json!({ "name": "a", "allowFrom": ["nope"] }),
                json!({ "name": "a", "expires": 0 })] {
        let mut m = bad.clone();
        m["type"] = json!("PLAY_LINK_CREATE");
        assert_eq!(admin(&c, &s, m).await["kind"], json!("bad_request"), "{bad}");
    }
    // Admin only, to create; a TV's secret needs no session to exchange.
    assert_eq!(c.handle(json!({ "type": "PLAY_LINK_CREATE", "name": "x" })).await["kind"], json!("unauthenticated"));
    assert_eq!(exchange(&c, "epdisplay_0000", None).await["kind"], json!("bad_credentials"));
}

/* ------------------------------- node-name history ------------------------------- */

async fn nodes_now(c: &Arc<Core>) {
    let r = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "nodes", "wait": true, "maxAgeSec": 0 })).await;
    assert_eq!(r["entry"]["status"], json!("ok"), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_missing_from_a_nodes_answer_has_left_until_forgotten_and_it_survives_a_restart() {
    let dir = TempDir::new("play-nodes");
    let names = Arc::new(Mutex::new(vec!["es-hot-01", "es-hot-02"]));
    let es = cluster(names.clone()).await;
    let start = |dir: &TempDir| Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let prime = |c: Arc<Core>, url: String| async move {
        let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [{ "id": "c1", "url": url }] })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
    };
    {
        let c = start(&dir);
        prime(c.clone(), es.url()).await;
        c.start_fleet_poller();
        // Two node listings a few milliseconds apart: the duplicate-request gap would answer
        // the second from the first (tests/gap.rs); this is about what the second says.
        c.set_min_gap_for_tests(0);
        nodes_now(&c).await;
        let st = c.handle(json!({ "type": "PLAY_STATE" })).await;
        assert_eq!(st["nodes"]["c1"]["left"], json!([]), "{st}");
        assert_eq!(st["nodes"]["c1"]["expected"], json!(["es-hot-01", "es-hot-02"]));
        let hits = es.hits().len();
        // The next answer has no es-hot-02.
        names.lock().unwrap().retain(|n| *n != "es-hot-02");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        nodes_now(&c).await;
        let st = c.handle(json!({ "type": "PLAY_STATE" })).await;
        let left = &st["nodes"]["c1"]["left"];
        assert_eq!(left.as_array().unwrap().len(), 1, "{st}");
        assert_eq!(left[0]["node"], json!("es-hot-02"));
        assert!(left[0]["since"].as_u64().unwrap() > 0);
        assert_eq!(st["nodes"]["c1"]["answering"], json!(true));
        // Play itself sent nothing: the two node listings (and their allocation) are all.
        let sent: Vec<String> = es.hits()[hits..].iter().map(|h| h.path.clone()).collect();
        assert!(sent.iter().all(|p| p.starts_with("/_cat/nodes") || p.starts_with("/_cat/allocation")), "{sent:?}");
    }
    // A restart keeps who left and since when.
    let c = start(&dir);
    prime(c.clone(), es.url()).await;
    let st = c.handle(json!({ "type": "PLAY_STATE" })).await;
    assert_eq!(st["nodes"]["c1"]["left"][0]["node"], json!("es-hot-02"), "{st}");
    // Removed on purpose: forgotten, and it stays forgotten across a restart.
    // The wall acknowledged it (nodeBlink: untilAck); forgetting the node clears that too.
    let a = c.handle(json!({ "type": "ACK_SET", "key": "c1:node-left" })).await;
    assert_eq!(a["ok"], json!(true), "{a}");
    assert!(c.handle(json!({ "type": "ACK_LIST" })).await["acks"].get("c1:node-left").is_some());
    let f = c.handle(json!({ "type": "PLAY_NODE_FORGET", "clusterId": "c1", "node": "es-hot-02" })).await;
    assert_eq!((f["ok"].clone(), f["ackCleared"].clone()), (json!(true), json!(true)), "{f}");
    assert!(c.handle(json!({ "type": "ACK_LIST" })).await["acks"].get("c1:node-left").is_none());
    assert_eq!(c.handle(json!({ "type": "PLAY_STATE" })).await["nodes"]["c1"]["left"], json!([]));
    assert_eq!(c.handle(json!({ "type": "PLAY_NODE_FORGET", "clusterId": "c1", "node": "es-hot-02" })).await["kind"], json!("not_found"));
    drop(c);
    let c = start(&dir);
    prime(c.clone(), es.url()).await;
    assert_eq!(c.handle(json!({ "type": "PLAY_STATE" })).await["nodes"]["c1"]["left"], json!([]));
}

/* ----------------------------- shared acknowledgements ----------------------------- */

// The acknowledgement test lives in tests/play_audit.rs, a binary of its own: it captures
// audit lines with a thread-local subscriber, which other tests in this binary (running in
// parallel, hitting the same ACK_SET callsite) could make miss its first line.

/* ---------------------------- shared measurement cache ---------------------------- */

#[tokio::test]
async fn the_shared_cache_keeps_the_newest_capped_and_only_for_visible_clusters() {
    let dir = TempDir::new("play-share");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let es = cluster(Arc::new(Mutex::new(vec!["n1"]))).await;
    prime(&c, &s, &es).await;
    let (_, secret) = create(&c, &s, json!({ "name": "c1 wall", "clusters": ["c1"] })).await;
    let tok = exchange(&c, &secret, ip("10.0.0.1")).await["session"].as_str().unwrap().to_string();
    let now = elasticpro_core::fleet::now_ms();
    let tv = |m: Value| { let (c, tok) = (c.clone(), tok.clone()); async move { as_display(&c, &tok, m, ip("10.0.0.1")).await } };

    let put = tv(json!({ "type": "PLAY_SHARE_PUT", "kind": "delay", "clusterId": "c1", "measuredAt": now,
        "data": { "devices": [{ "device": "fw-01", "delayMin": 42 }] } })).await;
    assert_eq!((put["ok"].clone(), put["kept"].clone()), (json!(true), json!(true)), "{put}");
    let older = tv(json!({ "type": "PLAY_SHARE_PUT", "kind": "delay", "clusterId": "c1", "measuredAt": now - 60_000, "data": [] })).await;
    assert_eq!(older["kept"], json!(false), "the newest one stays");
    assert_eq!(tv(json!({ "type": "PLAY_SHARE_PUT", "kind": "delay", "clusterId": "c2", "measuredAt": now, "data": [] })).await["kind"],
               json!("forbidden"), "not the link's cluster");
    let many: Vec<Value> = (0..2001).map(|i| json!({ "device": format!("d{i}") })).collect();
    let big = tv(json!({ "type": "PLAY_SHARE_PUT", "kind": "delay", "clusterId": "c1", "measuredAt": now + 1, "data": many })).await;
    assert_eq!(big["kind"], json!("bad_request"), "{big}");

    // A person's repository size, and what each reader gets back.
    let rs = admin(&c, &s, json!({ "type": "PLAY_SHARE_PUT", "kind": "repoSize", "clusterId": "c2", "measuredAt": now,
        "data": { "repo": "s3-backup", "bytes": 123456 } })).await;
    assert_eq!(rs["ok"], json!(true), "{rs}");
    let got = tv(json!({ "type": "PLAY_SHARE_GET", "kind": "delay" })).await;
    assert_eq!(got["records"]["c1"]["data"]["devices"][0]["delayMin"], json!(42), "{got}");
    assert_eq!(got["records"]["c1"]["by"], json!("display:c1 wall"));
    let theirs = tv(json!({ "type": "PLAY_SHARE_GET", "kind": "repoSize", "clusterIds": ["c2"] })).await;
    assert_eq!(theirs["records"], json!({}), "c2 is not the wall's: {theirs}");
    let all = admin(&c, &s, json!({ "type": "PLAY_SHARE_GET", "kind": "repoSize" })).await;
    assert_eq!(all["records"]["c2"]["data"]["bytes"], json!(123456));
    // On disk, not in memory.
    assert!(std::fs::read_dir(dir.join("play").join("share").join("delay")).unwrap().count() == 1);
}

/* ----------------------------------- settings ----------------------------------- */

#[tokio::test]
async fn settings_round_trip_and_an_exclusion_needs_a_reason() {
    let dir = TempDir::new("play-settings");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let es = cluster(Arc::new(Mutex::new(vec!["n1"]))).await;
    prime(&c, &s, &es).await;
    let g = admin(&c, &s, json!({ "type": "PLAY_CONFIG_GET" })).await;
    assert_eq!(g["watch"]["delayYellowFromMin"], json!(30), "{g}");
    assert_eq!(g["managed"], json!([]));
    assert_eq!(g["linksEnabled"], json!(true));
    let no = admin(&c, &s, json!({ "type": "PLAY_CONFIG_SET", "settings": { "exclude": { "add": { "clusterId": "c2", "reason": " " } } } })).await;
    assert_eq!(no["kind"], json!("bad_request"), "{no}");
    assert!(no["message"].as_str().unwrap().contains("needs a reason"));
    let ok = admin(&c, &s, json!({ "type": "PLAY_CONFIG_SET", "settings": { "exclude": { "add": { "clusterId": "c2", "reason": "migrating to new hardware" } } } })).await;
    assert_eq!(ok["ok"], json!(true), "{ok}");
    assert_eq!(ok["exclude"][0]["by"], json!("Admin"));
    let w = admin(&c, &s, json!({ "type": "PLAY_CONFIG_SET", "settings": { "watch": { "delayRedAboveMin": 90, "spotlight": { "when": ["red", "yellow"] } } } })).await;
    assert_eq!(w["watch"]["delayRedAboveMin"], json!(90), "{w}");
    assert_eq!(w["watch"]["delayYellowFromMin"], json!(30), "left out, kept");
    // PLAY_STATE leaves the excluded cluster out of everything it names.
    let st = admin(&c, &s, json!({ "type": "PLAY_STATE" })).await;
    assert_eq!(st["excluded"], json!(["c2"]));
    assert_eq!(st["settings"]["watch"]["spotlight"]["when"], json!(["red", "yellow"]));
    // Only an admin changes them; a user reads them.
    let add = admin(&c, &s, json!({ "type": "USER_ADD", "name": "ula", "password": PASSWORD, "role": "user" })).await;
    assert_eq!(add["ok"], json!(true), "{add}");
    let u = c.handle(json!({ "type": "LOGIN", "name": "ula", "password": PASSWORD })).await["session"].as_str().unwrap().to_string();
    assert_eq!(admin(&c, &u, json!({ "type": "PLAY_CONFIG_GET" })).await["ok"], json!(true));
    assert!(admin(&c, &u, json!({ "type": "PLAY_CONFIG_GET" })).await.get("links").is_none());
    assert_eq!(admin(&c, &u, json!({ "type": "PLAY_CONFIG_SET", "settings": { "watch": {} } })).await["kind"], json!("forbidden"));
    assert_eq!(admin(&c, &u, json!({ "type": "PLAY_NODE_FORGET", "clusterId": "c1", "node": "x" })).await["kind"], json!("forbidden"));
    // Survives a restart.
    drop(c);
    let c = hosted(&dir);
    let s = admin_session_again(&c).await;
    assert_eq!(admin(&c, &s, json!({ "type": "PLAY_CONFIG_GET" })).await["watch"]["delayRedAboveMin"], json!(90));
}

async fn admin_session_again(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": PASSWORD })).await;
    res["session"].as_str().expect("a session").to_string()
}

#[tokio::test]
async fn ping_says_what_play_has_here() {
    let dir = TempDir::new("play-ping");
    let p = hosted(&dir).handle(json!({ "type": "PING" })).await;
    assert_eq!((p["playLinks"].clone(), p["sharedAcks"].clone()), (json!(true), json!(true)), "{p}");
    let d = Core::new_with_rounds(None, Edition::Portable, 1).handle(json!({ "type": "PING" })).await;
    assert_eq!((d["playLinks"].clone(), d["sharedAcks"].clone()), (json!(false), json!(false)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pinned_node_lists_are_cut_to_the_clusters_the_caller_sees() {
    let dir = TempDir::new("play-pinned");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let es = cluster(Arc::new(Mutex::new(vec!["n1"]))).await;
    prime(&c, &s, &es).await;
    let set = admin(&c, &s, json!({ "type": "PLAY_CONFIG_SET", "settings": { "watch": { "nodeExpected": "pinned",
        "pinned": { "c1": ["es-hot-01"], "c2": ["hidden-node-of-c2"] } } } })).await;
    assert_eq!(set["ok"], json!(true), "{set}");
    assert_eq!(set["watch"]["pinned"]["c2"], json!(["hidden-node-of-c2"]), "an administrator who sees both sees both: {set}");
    let (_, key) = create(&c, &s, json!({ "name": "Team A TV", "clusters": ["c1"] })).await;
    let ex = exchange(&c, &key, None).await;
    let tok = ex["session"].as_str().unwrap().to_string();
    let ps = as_display(&c, &tok, json!({ "type": "PLAY_STATE" }), None).await;
    assert_eq!(ps["ok"], json!(true), "{ps}");
    assert_eq!(ps["settings"]["watch"]["pinned"], json!({ "c1": ["es-hot-01"] }), "only the link's cluster: {ps}");
    assert!(!ps.to_string().contains("hidden-node-of-c2"), "{ps}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changes_to_the_play_settings_made_at_once_are_all_kept() {
    let dir = TempDir::new("play-race");
    let c = hosted(&dir);
    let s = admin_session(&c).await;
    let es = cluster(Arc::new(Mutex::new(vec!["n1"]))).await;
    prime(&c, &s, &es).await;
    let (_, key) = create(&c, &s, json!({ "name": "Wall", "clusters": "all" })).await;
    let tok = exchange(&c, &key, None).await["session"].as_str().unwrap().to_string();
    // Forty exclusions and forty TV zooms at once: each is a read-modify-write of play.json.
    let mut jobs = vec![];
    for i in 0..40 {
        let (c2, s2, t2) = (c.clone(), s.clone(), tok.clone());
        jobs.push(tokio::spawn(async move {
            admin(&c2, &s2, json!({ "type": "PLAY_CONFIG_SET", "settings": { "exclude": { "add": { "clusterId": format!("x{i}"), "reason": "race" } } } })).await;
            as_display(&c2, &t2, json!({ "type": "PLAY_ZOOM_SET", "zoom": if i % 2 == 0 { 1.25 } else { 0.9 } }), None).await;
        }));
    }
    for j in jobs {
        j.await.unwrap();
    }
    let got = admin(&c, &s, json!({ "type": "PLAY_CONFIG_GET" })).await;
    let n = got["exclude"].as_array().map(Vec::len).unwrap_or(0);
    assert_eq!(n, 40, "every exclusion made at once is kept: {got}");
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("play.json")).unwrap()).unwrap();
    assert_eq!(on_disk["exclude"].as_array().map(Vec::len), Some(40), "and on disk");
}
