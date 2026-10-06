//! The scheduled log-delay measurement, through the real message API and a real socket.
//!
//! `delay_sink.rs`'s own tests prove the arithmetic. These prove the three claims that
//! matter about a job which runs unattended and writes:
//!
//!   * it does not exist outside the hosted edition,
//!   * it sends nothing at all until every gate is open — proved by counting TCP
//!     accepts, not by reading a return value,
//!   * and when it does run, it sends exactly one search and one `_bulk`, with ids that
//!     repeat so a second run overwrites the first.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::Arc;
use support::{TempDir, TestServer};

/// A cluster that answers the delay search with two devices — one measurable, one whose
/// event time is missing — and accepts a bulk.
async fn cluster() -> TestServer {
    TestServer::with(|hit| {
        if hit.path.starts_with("/_bulk") {
            return (200, r#"{"took":3,"errors":false,"items":[{"index":{"status":201}}]}"#.into());
        }
        (
            200,
            json!({ "took": 5, "aggregations": { "devices": { "buckets": [
                { "key": "fw-1", "doc_count": 120, "latest": { "hits": { "hits": [
                    { "_source": { "@timestamp": "2026-09-19T12:41:00Z", "ingested_time": "2026-09-19T12:00:00Z" } },
                ] } } },
                { "key": "fw-2", "doc_count": 4, "latest": { "hits": { "hits": [
                    { "_source": { "@timestamp": "2026-09-19T12:41:00Z" } },
                ] } } },
            ] } } })
            .to_string(),
        )
    })
    .await
}

fn core(dir: &TempDir, edition: Edition) -> Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), edition, 1)
}

const PASSWORD: &str = "correct-horse-battery";

/// Sign in to a core whose account has already had its forced change done — what the
/// second process in the restart test sees.
async fn sign_in(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": PASSWORD })).await;
    res["session"].as_str().expect("a session").to_string()
}

async fn admin(c: &Arc<Core>) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": "elasticpro", "password": support::first_password(c) })).await;
    let s = res["session"].as_str().expect("a session").to_string();
    let ch = c
        .handle(json!({ "type": "USER_SET_PASSWORD", "session": &s, "name": "elasticpro", "password": PASSWORD }))
        .await;
    assert_eq!(ch["ok"], json!(true), "{ch}");
    s
}

async fn prime(c: &Arc<Core>, session: &str, url: &str, read_only: bool) {
    let res = c
        .handle(json!({ "type": "PRIME", "session": session, "readOnly": read_only, "clusters": [
            { "id": "prod", "url": url },
            { "id": "kibana", "url": url },
        ] }))
        .await;
    assert_eq!(res["ok"], json!(true), "{res}");
}

fn armed(sink: &str) -> Value {
    json!({ "enabled": true, "sinkClusterId": sink, "everyHours": 2,
            "indexPrefix": "elasticpro-log-delay", "indexPattern": "logstash-*" })
}

async fn arm(c: &Arc<Core>, session: &str) -> Value {
    c.handle(json!({ "type": "DELAY_SINK_SET", "session": session, "config": armed("kibana") })).await
}

#[tokio::test]
async fn the_desktop_editions_have_no_scheduler_at_all() {
    let dir = TempDir::new("sink-portable");
    // Portable has no accounts, so no session is needed to ask.
    let res = core(&dir, Edition::Portable).handle(json!({ "type": "DELAY_SINK_GET" })).await;
    assert_eq!(res["supported"], json!(false), "{res}");

    let dir = TempDir::new("sink-installed");
    let c = core(&dir, Edition::Installed);
    let s = admin(&c).await;
    let res = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s, "config": armed("kibana") })).await;
    assert_eq!(res["supported"], json!(false), "installed is not a daemon either: {res}");
    // And nothing was written for a later hosted run to pick up.
    assert!(!dir.0.join("delay-sink.json").exists(), "a non-scheduling edition must not save a schedule");
}

#[tokio::test]
async fn arming_it_needs_an_admin() {
    let dir = TempDir::new("sink-role");
    let c = core(&dir, Edition::Hosted);
    let anon = c.handle(json!({ "type": "DELAY_SINK_SET", "config": armed("kibana") })).await;
    assert_eq!(anon["ok"], json!(false), "{anon}");
    let reading = c.handle(json!({ "type": "DELAY_SINK_GET" })).await;
    assert_eq!(reading["ok"], json!(false), "even reading the schedule is admin-only: {reading}");
}

#[tokio::test]
async fn arming_it_does_not_run_it() {
    let dir = TempDir::new("sink-arm");
    let srv = cluster().await;
    let c = core(&dir, Edition::Hosted);
    let s = admin(&c).await;
    prime(&c, &s, &srv.url(), false).await;

    let res = arm(&c, &s).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(res["state"]["runs"], json!(0));
    assert_eq!(srv.connections(), 0, "arming must not send anything: somebody is still typing");
    let due = res["state"]["nextDueAt"].as_i64().expect("a due time");
    let now = elasticpro_core::delay_sink::now_ms();
    assert!(due > now + 3_600_000, "the first run is an interval out, not immediate");
}

#[tokio::test]
async fn a_read_only_config_stops_it_before_the_socket() {
    let dir = TempDir::new("sink-readonly");
    let srv = cluster().await;
    let c = core(&dir, Edition::Hosted);
    let s = admin(&c).await;
    prime(&c, &s, &srv.url(), true).await;
    assert_eq!(arm(&c, &s).await["ok"], json!(true));

    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(false), "{run}");
    let why = run["skipped"].as_str().unwrap_or("");
    assert!(why.contains("read-only"), "the refusal should name the setting: {why}");
    assert_eq!(srv.connections(), 0, "a refused run reaches no cluster");
    assert_eq!(run["state"]["runs"], json!(0), "a refusal is not a run");
}

#[tokio::test]
async fn an_unprimed_core_refuses_rather_than_guessing() {
    let dir = TempDir::new("sink-unprimed");
    let c = core(&dir, Edition::Hosted);
    let s = admin(&c).await;
    assert_eq!(arm(&c, &s).await["ok"], json!(true));

    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    let why = run["skipped"].as_str().unwrap_or("");
    assert!(why.contains("primed"), "{run}");
    // A refusal does not back off — the thing it is waiting for is a person, not a server.
    assert_eq!(run["state"]["consecutiveFailures"], json!(0));
}

#[tokio::test]
async fn a_run_sends_one_search_and_one_bulk_per_cluster() {
    let dir = TempDir::new("sink-run");
    let srv = cluster().await;
    let c = core(&dir, Edition::Hosted);
    let s = admin(&c).await;
    prime(&c, &s, &srv.url(), false).await;
    assert_eq!(arm(&c, &s).await["ok"], json!(true));

    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(true), "{run}");
    // "prod" is measured; "kibana" is the sink and is not measured as well.
    assert_eq!(run["clusters"], json!(1), "{run}");
    assert_eq!(run["measured"], json!(1), "one of the two devices could be measured: {run}");

    let hits = srv.hits();
    let searches: Vec<_> = hits.iter().filter(|h| h.path.contains("/_search")).collect();
    let bulks: Vec<_> = hits.iter().filter(|h| h.path.starts_with("/_bulk")).collect();
    assert_eq!(searches.len(), 1, "one search per measured cluster: {:?}", hits.iter().map(|h| &h.path).collect::<Vec<_>>());
    assert_eq!(bulks.len(), 1, "one bulk per measured cluster");
    assert!(searches[0].path.starts_with("/logstash-*/_search"), "{}", searches[0].path);

    let body = &bulks[0].body;
    assert!(body.contains(r#""delay_minutes":41"#), "the delay is the subtraction, not a verdict: {body}");
    assert!(!body.contains("fw-2"), "the device missing a timestamp is absent, not zero: {body}");
    assert!(!body.contains("status"), "no classification is shipped: {body}");
    assert!(body.contains("elasticpro-log-delay-"), "{body}");

    // A second run inside the same hour writes the same ids, so it overwrites.
    let first_id = body.lines().next().expect("an action line").to_string();
    c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    let again = srv.hits();
    let last_bulk = again.iter().rev().find(|h| h.path.starts_with("/_bulk")).expect("a second bulk");
    assert_eq!(last_bulk.body.lines().next().unwrap(), first_id, "the same measurement keeps the same id");
}

#[tokio::test]
async fn the_schedule_survives_a_restart_but_the_run_history_does_not() {
    let dir = TempDir::new("sink-restart");
    let srv = cluster().await;
    {
        let c = core(&dir, Edition::Hosted);
        let s = admin(&c).await;
        prime(&c, &s, &srv.url(), false).await;
        assert_eq!(arm(&c, &s).await["ok"], json!(true));
    }
    let c = core(&dir, Edition::Hosted);
    let s = sign_in(&c).await;
    let res = c.handle(json!({ "type": "DELAY_SINK_GET", "session": &s })).await;
    assert_eq!(res["config"]["enabled"], json!(true), "{res}");
    assert_eq!(res["config"]["sinkClusterId"], json!("kibana"));
    // Nothing is primed yet in the new process, so the reason it cannot run right now is
    // visible without having to wait for a tick to fail.
    assert!(res["blocked"].as_str().unwrap_or("").contains("primed"), "{res}");
}

#[tokio::test]
async fn a_config_that_cannot_work_is_refused_at_the_point_of_arming() {
    let dir = TempDir::new("sink-bad");
    let c = core(&dir, Edition::Hosted);
    let s = admin(&c).await;
    let res = c
        .handle(json!({ "type": "DELAY_SINK_SET", "session": &s,
                        "config": { "enabled": true, "sinkClusterId": "" } }))
        .await;
    assert_eq!(res["ok"], json!(false), "{res}");
    assert!(res["message"].as_str().unwrap_or("").contains("sink cluster"), "{res}");
    assert!(!dir.0.join("delay-sink.json").exists(), "a refused config is not saved");
}

#[tokio::test]
async fn a_switched_off_schedule_is_not_reported_as_blocked() {
    // Found by running the real hosted stack: a fresh install showed "cannot run right
    // now: the sink cluster is not primed" before anybody had armed anything. Nothing is
    // in the way of a job that was never asked to run.
    let dir = TempDir::new("sink-quiet");
    let c = core(&dir, Edition::Hosted);
    let s = admin(&c).await;
    let res = c.handle(json!({ "type": "DELAY_SINK_GET", "session": &s })).await;
    assert_eq!(res["config"]["enabled"], json!(false));
    assert!(res["blocked"].is_null(), "a disarmed schedule must not warn: {res}");

    // Armed and unable to run, it says so — that warning is the useful one.
    let srv = cluster().await;
    prime(&c, &s, &srv.url(), true).await;
    assert_eq!(arm(&c, &s).await["ok"], json!(true));
    let res = c.handle(json!({ "type": "DELAY_SINK_GET", "session": &s })).await;
    assert!(res["blocked"].as_str().unwrap_or("").contains("read-only"), "{res}");

    // And "Run now" on a disarmed schedule still refuses, because that is a run somebody
    // asked for — it must not silently do nothing.
    let off = c.handle(json!({ "type": "DELAY_SINK_SET", "session": &s,
                               "config": { "enabled": false, "sinkClusterId": "" } })).await;
    assert_eq!(off["ok"], json!(true), "{off}");
    let run = c.handle(json!({ "type": "DELAY_SINK_RUN", "session": &s })).await;
    assert_eq!(run["ok"], json!(false), "{run}");
    assert!(run["skipped"].as_str().is_some(), "a refused run must say why: {run}");
}
