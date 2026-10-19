//! Every deletion is logged, and a dry run says "would remove". This is its own test binary
//! because it installs the process-wide tracing subscriber to read what the core logs.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use support::TempDir;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Capture {
        self.clone()
    }
}

fn put(path: &std::path::Path, bytes: usize, age: Duration) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, vec![b'x'; bytes]).unwrap();
    std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(SystemTime::now() - age).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_removal_is_a_log_line_on_the_audit_target_and_a_dry_run_says_would() {
    let cap = Capture::default();
    // `LOG_LEVEL=error` is the harshest setting: the audit target must still come through.
    let filter = tracing_subscriber::EnvFilter::new("error,audit=info");
    tracing_subscriber::fmt().json().with_env_filter(filter).with_writer(cap.clone()).init();

    let dir = TempDir::new("hk-log");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Portable, 1);
    c.handle(json!({ "type": "PRIME", "clusters": [{ "id": "c1", "url": "http://127.0.0.1:9" }] })).await;
    let gone = dir.join("cache/gone/health.json");
    let stale = dir.join("cache/c1/indices.json");
    put(&gone, 10, Duration::from_secs(3600));
    put(&stale, 20, Duration::from_secs(5 * 86_400));

    let lines = |cap: &Capture| -> Vec<Value> {
        String::from_utf8(cap.0.lock().unwrap().clone()).unwrap().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["target"] == json!("audit") && v["fields"]["message"].as_str().is_some_and(|m| m.starts_with("housekeeping: ")))
            .collect()
    };

    c.handle(json!({ "type": "HOUSEKEEPING_RUN", "dryRun": true })).await;
    let dry = lines(&cap);
    let would: Vec<&Value> = dry.iter().filter(|v| v["fields"]["message"] == json!("housekeeping: would remove")).collect();
    assert!(would.iter().any(|v| v["fields"]["detail"].as_str().unwrap().contains("gone")), "{dry:?}");
    assert!(would.iter().any(|v| v["fields"]["detail"].as_str().unwrap().contains("indices.json")), "{dry:?}");
    assert!(!dry.iter().any(|v| v["fields"]["message"] == json!("housekeeping: removed")), "a dry run never says removed");
    assert!(would.iter().all(|v| v["fields"]["dry_run"] == json!(true)));
    assert!(gone.exists());

    c.handle(json!({ "type": "HOUSEKEEPING_RUN" })).await;
    let all = lines(&cap);
    let removed: Vec<&Value> = all.iter().filter(|v| v["fields"]["message"] == json!("housekeeping: removed")).collect();
    assert_eq!(removed.iter().filter(|v| v["fields"]["job"] == json!("fleet-cache") && v["fields"]["what"] == json!("cache file")).count(), 2, "{all:?}");
    let g = removed.iter().find(|v| v["fields"]["detail"].as_str().unwrap().contains("health.json")).unwrap();
    assert_eq!(g["fields"]["bytes"], json!(10));
    assert!(g["fields"]["detail"].as_str().unwrap().contains("no longer configured"), "it says why: {g}");
    assert!(removed.iter().any(|v| v["fields"]["what"] == json!("cache folder")));
    assert!(!gone.exists() && !stale.exists());
    // The run itself is summarised too.
    assert!(all.iter().any(|v| v["fields"]["message"] == json!("housekeeping: run finished")));
}
