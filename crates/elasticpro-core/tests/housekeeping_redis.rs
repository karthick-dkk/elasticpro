//! Housekeeping's Redis job, against a stand-in that speaks just enough RESP: it answers
//! SCAN with a fixed key list (whatever MATCH says, as a careless server might), STRLEN
//! with a size, and records every command it is sent, so the claim is about what reached
//! Redis — only `DEL`s of `elasticpro:ds:<cluster>:<dataset>` keys of clusters that are not
//! configured, and none at all on a dry run.

#![cfg(feature = "bridge")]

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

type Log = Arc<Mutex<Vec<Vec<String>>>>;

/// The core reads ELASTICPRO_REDIS_URL once, when it is built; the environment is one per
/// process and these tests run side by side, so building a core is done one at a time.
static ENV: Mutex<()> = Mutex::new(());

fn core(url: Option<String>, tag: &str) -> (Arc<Core>, TempDir) {
    let _one_at_a_time = ENV.lock().unwrap_or_else(|e| e.into_inner());
    match url {
        Some(u) => std::env::set_var("ELASTICPRO_REDIS_URL", u),
        None => std::env::remove_var("ELASTICPRO_REDIS_URL"),
    }
    let dir = TempDir::new(tag);
    (Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1), dir)
}

/// `keys` is what SCAN returns, in one batch.
async fn fake_redis(keys: Vec<&'static str>) -> (u16, Log) {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let log2 = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = l.accept().await else { break };
            let (log, keys) = (log2.clone(), keys.clone());
            tokio::spawn(async move {
                let (r, mut w) = sock.into_split();
                let mut r = BufReader::new(r);
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let Some(n) = line.trim().strip_prefix('*').and_then(|n| n.parse::<usize>().ok()) else { return };
                    let mut args = vec![];
                    for _ in 0..n {
                        let mut len = String::new();
                        r.read_line(&mut len).await.unwrap();
                        let len: usize = len.trim().trim_start_matches('$').parse().unwrap();
                        let mut buf = vec![0u8; len + 2];
                        r.read_exact(&mut buf).await.unwrap();
                        args.push(String::from_utf8_lossy(&buf[..len]).to_string());
                    }
                    let reply: Vec<u8> = match args[0].to_ascii_uppercase().as_str() {
                        "SCAN" => {
                            let mut out = format!("*2\r\n$1\r\n0\r\n*{}\r\n", keys.len());
                            for k in &keys {
                                out.push_str(&format!("${}\r\n{k}\r\n", k.len()));
                            }
                            out.into_bytes()
                        }
                        "STRLEN" => b":1000\r\n".to_vec(),
                        "DEL" | "PUBLISH" => b":1\r\n".to_vec(),
                        _ => b"+OK\r\n".to_vec(),
                    };
                    log.lock().unwrap().push(args);
                    let _ = w.write_all(&reply).await;
                }
            });
        }
    });
    (port, log)
}

const KEYS: [&str; 9] = [
    "elasticpro:ds:c1:health",            // configured: stays
    "elasticpro:ds:gone:health",          // removed cluster: goes
    "elasticpro:ds:gone:indices",         // goes
    "elasticpro:ds:team:eu:shards",       // a removed cluster whose id has a colon: goes
    "elasticpro:ds:gone:notadataset",     // the right prefix, not a dataset this build writes: left alone
    "elasticpro:ds:weird",                // no cluster/dataset shape: left alone
    "other:ds:gone:health",               // not our prefix (a careless MATCH): left alone
    "elasticpro:updates",                 // our channel name, not a dataset key: left alone
    "elasticpro:ds:c1:indices",           // configured: stays
];

fn dels(log: &Log) -> Vec<String> {
    log.lock().unwrap().iter().filter(|a| a[0].eq_ignore_ascii_case("DEL")).map(|a| a[1..].join(" ")).collect()
}

fn job<'a>(run: &'a Value, id: &str) -> &'a Value {
    run["jobs"].as_array().unwrap().iter().find(|j| j["id"] == json!(id)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_keys_of_removed_clusters_are_deleted_and_a_dry_run_deletes_none() {
    let (port, log) = fake_redis(KEYS.to_vec()).await;
    let (c, _dir) = core(Some(format!("redis://127.0.0.1:{port}/")), "hk-redis");
    let r = c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "c1", "url": "http://127.0.0.1:9" }] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");

    let dry = c.handle(json!({ "type": "HOUSEKEEPING_RUN", "dryRun": true })).await;
    let j = job(&dry["run"], "redis");
    assert_eq!((j["ok"].clone(), j["items"].clone(), j["bytes"].clone()), (json!(true), json!(3), json!(3000)), "{j}");
    assert!(dels(&log).is_empty(), "a dry run sends no DEL: {:?}", log.lock().unwrap());

    let real = c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    assert_eq!(job(&real["run"], "redis")["items"], json!(3));
    let mut sent = dels(&log);
    sent.sort();
    assert_eq!(sent, vec!["elasticpro:ds:gone:health", "elasticpro:ds:gone:indices", "elasticpro:ds:team:eu:shards"],
        "exactly the three, one key per DEL, nothing outside the prefix");
    // Every command was SCAN, STRLEN or DEL — housekeeping reads nothing else and writes
    // nothing else — apart from the client library's own handshake.
    for a in log.lock().unwrap().iter() {
        assert!(["SCAN", "STRLEN", "DEL", "CLIENT", "HELLO", "SELECT", "PING"].contains(&a[0].to_ascii_uppercase().as_str()), "unexpected command {a:?}");
    }
    let scan = log.lock().unwrap().iter().find(|a| a[0] == "SCAN").cloned().unwrap();
    assert!(scan.contains(&"elasticpro:ds:*".to_string()), "the scan is limited to the prefix: {scan:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_no_cluster_list_redis_is_left_alone_and_a_dead_redis_is_one_failed_job() {
    // No clusters primed: every key would look removed. Nothing is deleted.
    let (port, log) = fake_redis(KEYS.to_vec()).await;
    let (c, _dir) = core(Some(format!("redis://127.0.0.1:{port}/")), "hk-redis-unprimed");
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    let j = job(&r["run"], "redis");
    assert!(j["skipped"].as_str().unwrap().contains("not checked"), "{j}");
    assert!(dels(&log).is_empty());

    // Redis configured but not answering: the job fails, says so, and the run still completes.
    let dead = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let (c, _dir) = core(Some(format!("redis://127.0.0.1:{dead}/")), "hk-redis-dead");
    c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "c1", "url": "http://127.0.0.1:9" }] })).await;
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    let j = job(&r["run"], "redis");
    assert_eq!(j["ok"], json!(false), "{j}");
    assert!(j["error"].as_str().unwrap().contains("redis"), "{j}");
    assert_eq!(r["run"]["errors"], json!(1));
    assert_eq!(job(&r["run"], "memory")["ok"], json!(true), "the other jobs ran");
}

#[tokio::test]
async fn without_redis_the_job_is_skipped() {
    let (c, _dir) = core(None, "hk-redis-none");
    let r = c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    assert_eq!(job(&r["run"], "redis")["skipped"], json!("Redis is not configured"));
}
