//! Restoring from Redis after the disk: only what is newer than the disk, only what fits
//! the budget, and decided without fetching the bodies. 0.3.21 fetched and parsed every
//! Redis entry before comparing any — a second copy of the whole cache at every start,
//! which is what took it past its memory limit.
//!
//! Its own test binary: the budget and the Redis URL are read once per process.

#![cfg(feature = "bridge")]

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::fleet::catalogue::Dataset;
use elasticpro_core::fleet::entry::{Body, Entry, Status};
use elasticpro_core::fleet::store::DiskStore;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

type Log = Arc<Mutex<Vec<Vec<String>>>>;

fn bulk(b: &[u8]) -> Vec<u8> {
    let mut o = format!("${}\r\n", b.len()).into_bytes();
    o.extend_from_slice(b);
    o.extend_from_slice(b"\r\n");
    o
}

/// Just enough Redis: SCAN (everything at once), STRLEN, GETRANGE, GET; anything else OK.
async fn fake_redis(store: HashMap<String, String>) -> (u16, Log) {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let (log2, store) = (log.clone(), Arc::new(store));
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = l.accept().await else { break };
            let (log, store) = (log2.clone(), store.clone());
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
                        tokio::io::AsyncReadExt::read_exact(&mut r, &mut buf).await.unwrap();
                        args.push(String::from_utf8_lossy(&buf[..len]).to_string());
                    }
                    let reply: Vec<u8> = match args[0].to_ascii_uppercase().as_str() {
                        "SCAN" => {
                            let mut o = b"*2\r\n$1\r\n0\r\n".to_vec();
                            o.extend(format!("*{}\r\n", store.len()).into_bytes());
                            for k in store.keys() {
                                o.extend(bulk(k.as_bytes()));
                            }
                            o
                        }
                        "STRLEN" => format!(":{}\r\n", store.get(&args[1]).map_or(0, String::len)).into_bytes(),
                        "GETRANGE" => {
                            let v = store.get(&args[1]).map(String::as_bytes).unwrap_or(b"");
                            let end = (args[3].parse::<usize>().unwrap() + 1).min(v.len());
                            bulk(&v[..end])
                        }
                        "GET" => match store.get(&args[1]) {
                            Some(v) => bulk(v.as_bytes()),
                            None => b"$-1\r\n".to_vec(),
                        },
                        "PUBLISH" | "DEL" => b":0\r\n".to_vec(),
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

fn entry(data: Value, fetched_at: u64) -> Entry {
    let mut e = Entry::never(1, None);
    e.status = Status::Ok;
    e.fetched_at = Some(fetched_at);
    e.data = Some(Body::from_value(&data));
    e
}

fn indices(n: usize) -> Value {
    json!({ "indices": { "ok": true, "json": "i".repeat(n) } })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_newer_entries_that_fit_are_fetched_from_redis() {
    std::env::set_var("ELASTICPRO_CACHE_MB", "1");
    let dir = TempDir::new("fleet-restore-redis");
    // Nothing goes to a cluster in this test: only the restore runs.
    // An emergency stop with an end far away: a stop with no end is dropped on load.
    std::fs::write(dir.join("policy.json"), r#"{"paused":{"all":true,"minutes":60,"since":1,"until":99999999999999}}"#).unwrap();
    let disk = DiskStore::new(Some(&dir.0));
    let health = json!({ "health": { "ok": true, "json": { "status": "green" } } });
    disk.save("c1", Dataset::Health, &entry(health.clone(), 1_000), 0);
    disk.save("c1", Dataset::Indices, &entry(indices(300_000), 1_000), 0);

    let mut store = HashMap::new();
    let put = |s: &mut HashMap<String, String>, k: &str, e: Entry| { s.insert(k.to_string(), serde_json::to_string(&e).unwrap()); };
    // Older than the disk's: decided from its head, never fetched.
    put(&mut store, "elasticpro:ds:c1:health", entry(health, 500));
    // Newer than the disk's: fetched, and it replaces the disk's copy.
    put(&mut store, "elasticpro:ds:c1:indices", entry(indices(300_001), 5_000));
    // Newest of all, but 900 KB on top of what is held does not fit 1 MiB: never fetched.
    put(&mut store, "elasticpro:ds:c2:indices", entry(indices(900_000), 6_000));
    let (port, log) = fake_redis(store).await;
    std::env::set_var("ELASTICPRO_REDIS_URL", format!("redis://127.0.0.1:{port}/"));

    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    let r = c.handle(json!({ "type": "PRIME", "readOnly": true, "clusters": [
        { "id": "c1", "url": "http://127.0.0.1:9" }, { "id": "c2", "url": "http://127.0.0.1:9" } ] })).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    c.start_fleet_poller();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let s = c.handle(json!({ "type": "FLEET_STATE", "include": ["health", "indices"] })).await;
        let ix = &s["clusters"]["c1"]["datasets"]["indices"];
        if ix["fetchedAt"] == json!(5_000) {
            assert_eq!(ix["status"], json!("restored"));
            assert_eq!(ix["data"]["indices"]["json"].as_str().map(str::len), Some(300_001), "Redis's body, not the disk's");
            assert_eq!(s["clusters"]["c1"]["datasets"]["health"]["fetchedAt"], json!(1_000), "the disk's health was newer");
            assert!(s["clusters"]["c2"]["datasets"].get("indices").is_none(), "over budget: not restored");
            break;
        }
        assert!(Instant::now() < deadline, "the newer Redis entry never arrived: {s}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let got = log.lock().unwrap().clone();
    let gets: Vec<&str> = got.iter().filter(|a| a[0] == "GET").map(|a| a[1].as_str()).collect();
    assert_eq!(gets, vec!["elasticpro:ds:c1:indices"], "only the one worth having was fetched: {gets:?}");
    assert!(got.iter().any(|a| a[0] == "GETRANGE" && a[1] == "elasticpro:ds:c1:health"), "freshness came from the head");
}
