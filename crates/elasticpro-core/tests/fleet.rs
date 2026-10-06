//! The fleet cache through the message API: what a page asks, what the poller sends to
//! the cluster, and who may see what.

mod support;

use elasticpro_core::auth::{Caller, Edition, Role};
use elasticpro_core::fleet::events::{EventsOwner, Reauth};
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::{TempDir, TestServer};

fn portable(dir: &TempDir) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1)
}

async fn prime(c: &Arc<Core>, clusters: Value) -> Value {
    let res = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": clusters })).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    res
}

/// A fake cluster that answers every catalogue request, and takes `slow` over `/_cat/indices`.
async fn cluster(slow: Duration) -> TestServer {
    TestServer::with(move |h| {
        let p = h.path.as_str();
        if p.starts_with("/_cat/indices") {
            std::thread::sleep(slow);
            return (200, r#"[{"index":"logs-2026.09.01","health":"green"}]"#.into());
        }
        if p.starts_with("/_snapshot?") {
            return (200, r#"{"repo1":{"type":"fs"}}"#.into());
        }
        if p.starts_with("/_cat/snapshots/repo1") {
            return (200, r#"[{"id":"snap-1","status":"SUCCESS"}]"#.into());
        }
        (200, r#"{"cluster_name":"test","status":"green"}"#.into())
    })
    .await
}

fn hits_on(s: &TestServer, prefix: &str) -> usize {
    s.hits().iter().filter(|h| h.path.starts_with(prefix)).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_waiters_share_one_fetch() {
    let dir = TempDir::new("fleet-coalesce");
    let es = cluster(Duration::from_millis(400)).await;
    let c = portable(&dir);
    prime(&c, json!([{ "id": "c1", "url": es.url() }])).await;
    c.start_fleet_poller();

    let ask = || {
        let c = c.clone();
        tokio::spawn(async move {
            c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "indices", "wait": true })).await
        })
    };
    let (a, b) = (ask(), ask());
    let (a, b) = (a.await.unwrap(), b.await.unwrap());
    for r in [&a, &b] {
        assert_eq!(r["ok"], json!(true), "{r}");
        assert_eq!(r["entry"]["status"], json!("ok"), "{r}");
        assert_eq!(r["entry"]["data"]["indices"]["json"][0]["index"], json!("logs-2026.09.01"));
    }
    assert_eq!(hits_on(&es, "/_cat/indices"), 1, "two waiters, one request to the cluster");

    // And fresh now: a third ask is answered from the cache.
    let c3 = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "indices", "wait": true })).await;
    assert_eq!(c3["waited"], json!(false), "{c3}");
    assert_eq!(hits_on(&es, "/_cat/indices"), 1);
    // The poller's requests are counted like a page's.
    let stats = c.request_stats();
    assert!(stats["clusters"]["c1"]["last5m"].as_u64().unwrap() >= 1, "{stats}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_background_set_arrives_and_snapshots_use_the_cat_listing_per_repo() {
    let dir = TempDir::new("fleet-bg");
    let es = cluster(Duration::ZERO).await;
    let c = portable(&dir);
    prime(&c, json!([{ "id": "c1", "url": es.url(), "logIndexPattern": "logs-*" }])).await;
    c.start_fleet_poller();

    let deadline = Instant::now() + Duration::from_secs(10);
    let state = loop {
        let s = c.handle(json!({ "type": "FLEET_STATE" })).await;
        let ds = &s["clusters"]["c1"]["datasets"];
        if ["health", "nodes", "ilm_errors", "policies", "ilm_assign", "snapshots"].iter().all(|d| ds[d]["status"] == json!("ok")) {
            break s;
        }
        assert!(Instant::now() < deadline, "the background set never arrived: {s}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let cl = &state["clusters"]["c1"];
    assert_eq!(cl["reach"]["state"], json!("reachable"));
    assert!(cl["datasets"].get("indices").is_none(), "on-demand datasets are not in the default set");
    assert_eq!(cl["datasets"]["snapshots"]["data"]["byRepo"]["repo1"]["json"][0]["id"], json!("snap-1"));
    assert!(es.hits().iter().any(|h| h.path.starts_with("/logs-*/_settings?filter_path=")), "the cluster's own log pattern");
    assert!(state["catalogue"].as_array().unwrap().len() == 9);

    // `since` returns only what changed after it.
    let seq = state["seq"].as_u64().unwrap();
    let again = c.handle(json!({ "type": "FLEET_STATE", "since": seq })).await;
    assert_eq!(again["clusters"], json!({}), "{again}");
    assert_eq!(again["clusterIds"], json!(["c1"]));
    // Indices were never asked for: an on-demand dataset nobody asked for is not listed at
    // all, even when included — rather than a "never" for every cluster in the fleet.
    let with = c.handle(json!({ "type": "FLEET_STATE", "include": ["indices"] })).await;
    assert!(with["clusters"]["c1"]["datasets"].get("indices").is_none(), "{with}");
    // One core, one epoch.
    assert!(!state["epoch"].as_str().unwrap_or("").is_empty());
    assert_eq!(with["epoch"], state["epoch"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_cluster_is_probed_every_two_minutes_and_nothing_else() {
    let dir = TempDir::new("fleet-down");
    let port = support::dead_port().await;
    let c = portable(&dir);
    prime(&c, json!([{ "id": "down", "url": format!("http://127.0.0.1:{port}") }])).await;
    c.start_fleet_poller();
    let t0 = elasticpro_core::fleet::now_ms();
    let r = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "down", "dataset": "health", "wait": true })).await;
    assert_eq!(r["reach"]["state"], json!("unreachable"), "{r}");
    assert_eq!(r["entry"]["status"], json!("error"));
    assert_eq!(r["entry"]["data"], Value::Null, "never fetched: unknown, not empty");
    let probe = r["reach"]["nextProbeAt"].as_u64().unwrap();
    assert!(probe >= t0 + 108_000 && probe <= elasticpro_core::fleet::now_ms() + 132_000, "{r}");

    // Asking for indices of a cluster that is down does not wait and does not send.
    let i = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "down", "dataset": "indices", "wait": true })).await;
    assert_eq!(i["waited"], json!(false));
    assert_eq!(i["entry"]["status"], json!("never"));
    let rf = c.handle(json!({ "type": "REFRESH", "clusterIds": ["down"] })).await;
    assert_eq!(rf["queued"], json!(1), "health only: {rf}");
}

#[tokio::test]
async fn the_disk_cache_comes_back_restored_and_forgets_removed_clusters() {
    let dir = TempDir::new("fleet-disk");
    let es = cluster(Duration::ZERO).await;
    {
        let c = portable(&dir);
        prime(&c, json!([{ "id": "keep", "url": es.url() }, { "id": "gone", "url": es.url() }])).await;
        c.start_fleet_poller();
        for id in ["keep", "gone"] {
            let r = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": id, "dataset": "health", "wait": true })).await;
            assert_eq!(r["entry"]["status"], json!("ok"), "{r}");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !(dir.join("cache/keep/health.json").exists() && dir.join("cache/gone/health.json").exists()) {
            assert!(Instant::now() < deadline, "the cache was never written");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("cache/keep/health.json")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    // The first core's poller ends with it; let what it had in flight finish.
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // A new process: primed with one of the two, then started. This test runs on one
    // thread, so nothing the poller spawned has run when FLEET_STATE is asked.
    let c = portable(&dir);
    prime(&c, json!([{ "id": "keep", "url": es.url() }])).await;
    c.start_fleet_poller();
    let s = c.handle(json!({ "type": "FLEET_STATE" })).await;
    let h = &s["clusters"]["keep"]["datasets"]["health"];
    assert_eq!(h["status"], json!("restored"), "{s}");
    assert_eq!(h["data"]["health"]["json"]["status"], json!("green"));
    assert!(h["fetchedAt"].as_u64().is_some(), "the time it was fetched, not now");
    assert!(s["clusters"].get("gone").is_none(), "only configured clusters are shown");

    let deadline = Instant::now() + Duration::from_secs(5);
    while dir.join("cache/gone").exists() {
        assert!(Instant::now() < deadline, "the removed cluster's cache was never pruned");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(dir.join("cache/keep").exists());
}

#[tokio::test]
async fn a_write_that_went_through_re_reads_what_it_changed() {
    let dir = TempDir::new("fleet-write");
    let es = TestServer::start().await;
    let c = portable(&dir);
    let res = c.handle(json!({ "type": "PRIME", "readOnly": false,
        "clusters": [{ "id": "w", "url": es.url() }, { "id": "s", "url": es.url() }] })).await;
    assert_eq!(res["ok"], json!(true));

    c.handle(json!({ "type": "ES", "clusterId": "w", "method": "POST", "path": "/logs-*/_search", "body": "{}" })).await;
    assert!(c.fleet_pending("w").is_empty(), "a search is a read");
    c.handle(json!({ "type": "ES", "clusterId": "w", "method": "DELETE", "path": "/logs-2026.01.01" })).await;
    assert_eq!(c.fleet_pending("w"), vec!["health", "indices", "shards"]);
    c.handle(json!({ "type": "ES", "clusterId": "w", "method": "PUT", "path": "/_snapshot/repo1/snap?wait_for_completion=false", "body": "{}" })).await;
    assert_eq!(c.fleet_pending("w"), vec!["health", "indices", "policies", "shards", "snapshots", "snapshots_full"]);

    // Executing an SLM policy takes a snapshot: the listings are re-read too.
    c.handle(json!({ "type": "ES", "clusterId": "s", "method": "POST", "path": "/_slm/policy/daily/_execute" })).await;
    assert_eq!(c.fleet_pending("s"), vec!["ilm_errors", "policies", "snapshots", "snapshots_full"]);

    // A write the guard refused changed nothing.
    let dir2 = TempDir::new("fleet-write-ro");
    let c2 = portable(&dir2);
    prime(&c2, json!([{ "id": "w", "url": es.url() }])).await;
    let r = c2.handle(json!({ "type": "ES", "clusterId": "w", "method": "DELETE", "path": "/idx" })).await;
    assert_eq!(r["kind"], json!("blocked_readonly"));
    assert!(c2.fleet_pending("w").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prime_does_not_wait_for_a_slow_request_in_flight() {
    let dir = TempDir::new("fleet-lock");
    let stall = TestServer::stall().await;
    let c = portable(&dir);
    prime(&c, json!([{ "id": "slow", "url": stall.url() }])).await;
    let c2 = c.clone();
    let slow = tokio::spawn(async move {
        c2.handle(json!({ "type": "ES", "clusterId": "slow", "path": "/", "timeoutMs": 4000 })).await
    });
    // Until the request is on the wire.
    let deadline = Instant::now() + Duration::from_secs(3);
    while stall.connections() == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let t = Instant::now();
    prime(&c, json!([{ "id": "slow", "url": stall.url() }])).await;
    assert!(t.elapsed() < Duration::from_secs(1), "PRIME waited {:?} for a request it has nothing to do with", t.elapsed());
    assert_eq!(slow.await.unwrap()["kind"], json!("timeout"));
}

/* ------------------------------------ who sees what ------------------------------------ */

fn who(name: &str, role: Role, scope: Option<Vec<&str>>) -> Caller {
    Caller { name: name.into(), role, must_change: false, scope: scope.map(|v| v.into_iter().map(String::from).collect()) }
}

async fn hosted_with_two_clusters(dir: &TempDir) -> Arc<Core> {
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let admin = who("root", Role::Admin, None);
    let r = c.handle_as(json!({ "type": "PRIME", "readOnly": true, "persist": false, "clusters": [
        { "id": "a", "url": "http://127.0.0.1:9", "zabbixGroups": ["G1"] },
        { "id": "b", "url": "http://127.0.0.1:9", "zabbixGroups": ["G2"] },
    ] }), Some(admin)).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c
}

#[tokio::test]
async fn a_scoped_caller_sees_only_their_own_clusters() {
    let dir = TempDir::new("fleet-scope");
    let c = hosted_with_two_clusters(&dir).await;
    let me = who("zu", Role::User, Some(vec!["G1"]));

    let s = c.handle_as(json!({ "type": "FLEET_STATE" }), Some(me.clone())).await;
    assert_eq!(s["ok"], json!(true), "{s}");
    assert_eq!(s["clusterIds"], json!(["a"]));
    // Not polled yet: the background set says so, one "never" each; nothing on demand.
    let ds = &s["clusters"]["a"]["datasets"];
    assert_eq!(ds["health"]["status"], json!("never"), "{s}");
    assert_eq!(ds["health"]["data"], Value::Null, "unknown, not empty");
    assert!(ds.get("indices").is_none() && ds.get("shards").is_none() && ds.get("snapshots_full").is_none());
    assert!(s["clusters"].get("b").is_none());

    let d = c.handle_as(json!({ "type": "CLUSTER_DATASET", "clusterId": "b", "dataset": "health" }), Some(me.clone())).await;
    assert_eq!(d["kind"], json!("forbidden"), "{d}");
    let r = c.handle_as(json!({ "type": "REFRESH", "clusterIds": ["a", "b"] }), Some(me.clone())).await;
    assert_eq!(r["kind"], json!("forbidden"), "{r}");
    // "all" means all of mine.
    let r = c.handle_as(json!({ "type": "REFRESH", "clusterIds": "all", "datasets": ["health"] }), Some(me.clone())).await;
    assert_eq!(r["queued"], json!(1), "{r}");
    // Once in ten seconds per person, cluster and dataset.
    let r = c.handle_as(json!({ "type": "REFRESH", "clusterIds": ["a"], "datasets": ["health"] }), Some(me)).await;
    assert_eq!((r["queued"].clone(), r["skipped"][0]["reason"].clone()), (json!(0), json!("rate_limited")));

    // Events follow the same line.
    let ev = |id: &str| elasticpro_core::fleet::events::FleetEvent { cluster_id: id.into(), dataset: None, payload: json!({}) };
    let scoped = who("zu", Role::User, Some(vec!["G1"]));
    assert!(c.fleet_event_visible(Some(&scoped), &ev("a")));
    assert!(!c.fleet_event_visible(Some(&scoped), &ev("b")));
}

#[tokio::test]
async fn a_guest_gets_health_and_nodes_and_nothing_else() {
    let dir = TempDir::new("fleet-guest");
    let c = hosted_with_two_clusters(&dir).await;
    let g = who("g", Role::Guest, None);
    let s = c.handle_as(json!({ "type": "FLEET_STATE", "include": ["health", "nodes", "policies", "indices"] }), Some(g.clone())).await;
    let mut names: Vec<String> = s["clusters"]["a"]["datasets"].as_object().unwrap().keys().cloned().collect();
    names.sort();
    assert_eq!(names, vec!["health", "nodes"]);
    let d = c.handle_as(json!({ "type": "CLUSTER_DATASET", "clusterId": "a", "dataset": "indices" }), Some(g.clone())).await;
    assert_eq!(d["kind"], json!("forbidden"), "{d}");
    let r = c.handle_as(json!({ "type": "REFRESH" }), Some(g)).await;
    assert_eq!(r["kind"], json!("forbidden"), "a guest cannot make the core go to the clusters: {r}");
}

#[tokio::test]
async fn an_events_ticket_works_once_and_follows_the_session() {
    let dir = TempDir::new("fleet-ticket");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let login = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(&c) })).await;
    let s = login["session"].as_str().unwrap().to_string();
    c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "elasticpro", "password": "correct-horse-battery" })).await;

    let t = c.handle(json!({ "type": "EVENTS_TICKET", "session": s })).await;
    assert_eq!(t["ok"], json!(true), "{t}");
    let ticket = t["ticket"].as_str().unwrap();
    let owner: EventsOwner = c.redeem_events_ticket(ticket).expect("first use");
    assert!(c.redeem_events_ticket(ticket).is_none(), "a ticket is single-use");
    assert!(matches!(owner.reauth, Reauth::Session(_)));
    assert_eq!(c.events_revalidate(&owner).flatten().map(|c| c.name), Some("elasticpro".into()));

    c.handle(json!({ "type": "LOGOUT", "session": s })).await;
    assert!(c.events_revalidate(&owner).is_none(), "signed out: the stream must close");

    // Without a session there is no ticket.
    let none = c.handle(json!({ "type": "EVENTS_TICKET" })).await;
    assert_eq!(none["kind"], json!("unauthenticated"));
}

#[tokio::test]
async fn ping_says_whether_the_fleet_cache_is_running() {
    let dir = TempDir::new("fleet-ping");
    let c = portable(&dir);
    assert_eq!(c.handle(json!({ "type": "PING" })).await["fleetCache"], json!(false));
    let off = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "x", "dataset": "health" })).await;
    assert_eq!(off["kind"], json!("not_found"));
    c.start_fleet_poller();
    assert_eq!(c.handle(json!({ "type": "PING" })).await["fleetCache"], json!(true));
}

#[tokio::test]
async fn a_guest_may_have_a_dataset_exactly_when_they_may_make_its_requests() {
    use elasticpro_core::fleet::catalogue::{Dataset, ALL, REPOS_PATH};
    let dir = TempDir::new("fleet-guest-same");
    let c = hosted_with_two_clusters(&dir).await;
    let g = who("g", Role::Guest, None);
    for ds in ALL {
        let paths: Vec<String> = match ds {
            Dataset::Snapshots | Dataset::SnapshotsFull => {
                vec![REPOS_PATH.to_string(), ds.repo_query("repo1").unwrap().path]
            }
            _ => ds.queries(None).into_iter().map(|q| q.path).collect(),
        };
        let mut es_ok = true;
        for p in &paths {
            let r = c.handle_as(json!({ "type": "ES", "clusterId": "a", "method": "GET", "path": p, "timeoutMs": 500 }), Some(g.clone())).await;
            es_ok &= r["kind"] != json!("forbidden");
        }
        let d = c.handle_as(json!({ "type": "CLUSTER_DATASET", "clusterId": "a", "dataset": ds.name() }), Some(g.clone())).await;
        let cache_ok = d["kind"] != json!("forbidden");
        assert_eq!(cache_ok, es_ok, "{}: the cache and the passthrough disagree ({d})", ds.name());
    }
    // Concretely: health and nodes both ways; the index list neither way.
    let idx = c.handle_as(json!({ "type": "ES", "clusterId": "a", "path": "/_cat/indices" }), Some(g)).await;
    assert_eq!(idx["kind"], json!("forbidden"));
}

#[tokio::test]
async fn each_run_of_the_core_has_its_own_epoch() {
    let dir = TempDir::new("fleet-epoch");
    let a = portable(&dir);
    let e1 = a.handle(json!({ "type": "FLEET_STATE" })).await["epoch"].clone();
    assert_eq!(a.handle(json!({ "type": "FLEET_STATE", "since": 0 })).await["epoch"], e1);
    let b = portable(&dir);
    let e2 = b.handle(json!({ "type": "FLEET_STATE" })).await["epoch"].clone();
    assert!(e1.is_string() && e2.is_string());
    assert_ne!(e1, e2, "a restarted core must be recognisable as one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cached_certificate_error_carries_what_the_trust_button_needs() {
    use support::tls::{self_signed, TlsServer};
    let dir = TempDir::new("fleet-trust");
    let cert = self_signed("localhost");
    let srv = TlsServer::start(&cert).await;
    let c = portable(&dir);
    prime(&c, json!([{ "id": "es", "url": srv.url(), "tls": "auto" }])).await;
    c.start_fleet_poller();

    let direct = c.handle(json!({ "type": "ES", "clusterId": "es", "path": "/" })).await;
    assert_eq!(direct["kind"], json!("tls_untrusted"), "{direct}");

    let r = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "es", "dataset": "health", "wait": true })).await;
    for (what, err) in [("entry.error", &r["entry"]["error"]), ("reach.lastError", &r["reach"]["lastError"])] {
        assert_eq!(err["kind"], json!("tls_untrusted"), "{what}: {r}");
        assert_eq!(err["cert"]["sha256"], direct["cert"]["sha256"], "{what} must carry the certificate: {r}");
        assert_eq!(err["cert"]["sha256"], json!(cert.sha256));
        assert_eq!(err["help"], direct["help"], "{what}");
        assert_eq!(err["pinned"], direct["pinned"], "{what}");
    }
    assert!(r["entry"]["data"].is_null(), "never fetched: nothing to show, not an empty body");
}
