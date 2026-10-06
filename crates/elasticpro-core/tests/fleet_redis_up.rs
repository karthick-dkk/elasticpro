//! The hosted build's Redis write-through, against a stand-in that speaks just enough
//! RESP to record what it was sent: every good dataset is SET under
//! `elasticpro:ds:{cluster}:{dataset}` with an expiry, and announced on `elasticpro:updates`.

#![cfg(feature = "bridge")]

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::{TempDir, TestServer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Commands received, each as its arguments.
type Log = Arc<Mutex<Vec<Vec<String>>>>;

async fn fake_redis() -> (u16, Log) {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let log2 = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = l.accept().await else { break };
            let log = log2.clone();
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
                    let reply: &[u8] = match args[0].to_ascii_uppercase().as_str() {
                        "PUBLISH" => b":0\r\n",
                        "SCAN" => b"*2\r\n$1\r\n0\r\n*0\r\n",
                        _ => b"+OK\r\n",
                    };
                    log.lock().unwrap().push(args);
                    let _ = w.write_all(reply).await;
                }
            });
        }
    });
    (port, log)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn good_datasets_are_written_through_and_announced() {
    let (port, log) = fake_redis().await;
    std::env::set_var("ELASTICPRO_REDIS_URL", format!("redis://127.0.0.1:{port}/"));
    let dir = TempDir::new("fleet-redis-up");
    let es = TestServer::start().await;
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "c1", "url": es.url() }] })).await;
    c.start_fleet_poller();
    let r = c.handle(json!({ "type": "CLUSTER_DATASET", "clusterId": "c1", "dataset": "health", "wait": true })).await;
    assert_eq!(r["entry"]["status"], json!("ok"), "{r}");

    // Generous: a first connect that fails waits five seconds before the next one.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let got = log.lock().unwrap().clone();
        let set = got.iter().find(|a| a[0] == "SET" && a[1] == "elasticpro:ds:c1:health");
        let publish = got.iter().find(|a| a[0] == "PUBLISH" && a[1] == "elasticpro:updates" && a[2].contains("\"health\""));
        if let (Some(set), Some(_)) = (set, publish) {
            assert_eq!(set[3], "EX");
            assert_eq!(set[4], "540", "three health intervals");
            let body: serde_json::Value = serde_json::from_str(&set[2]).unwrap();
            assert_eq!(body["status"], json!("ok"));
            break;
        }
        assert!(Instant::now() < deadline, "nothing written through: {got:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
