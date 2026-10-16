//! A record of what people did, in a form a SIEM can ingest.
//!
//! One JSON object per line, ECS field names, appended to a file under the data dir and
//! kept in a small ring for the Accounts page. This is deliberately not the `audit`
//! tracing target: that is a short list of changes, and `tools/hosted-check.sh` holds it
//! to "no GETs". This one answers "what did this person look at and try", reads included.
//!
//! What is never written: request bodies, passwords, tokens, session ids, or the `text`,
//! `password` and `secret` fields of any message. Events are built from a short list of
//! named fields rather than from the message, so a field somebody adds to a message later
//! cannot leak by being copied along.
//!
//! Writing must never hurt the request it describes. `record()` formats the line, puts it
//! in the in-memory ring and hands it to one dedicated writer thread over a bounded
//! channel; it never touches the disk and never waits. If the writer falls so far behind
//! that the channel is full the line is counted as dropped (one warning a minute at most)
//! rather than holding a request up. The writer owns the file, the rotation and the
//! reopen: an I/O error warns once and the log carries on, retrying the file on the next
//! event. A reopened file that does not end in a newline (a write cut short by a full
//! disk) gets one first, so a half line never merges with the next whole one.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::auth::{Caller, Edition};

/// Events the Accounts page can ask for. Older ones are still in the file.
pub const RING: usize = 1000;
pub const DEFAULT_MAX_MB: u64 = 50;
pub const DEFAULT_KEEP: usize = 5;
pub const FILE_NAME: &str = "activity.jsonl";
/// Lines waiting for the writer thread before new ones are dropped.
pub const QUEUE: usize = 10_000;

/// Messages the pages send on a timer or on every navigation. They are not something a
/// person did, and at one a few seconds they would bury everything that was.
const POLLS: &[&str] = &[
    "PING", "FLEET_STATE", "EVENTS_TICKET", "WHOAMI", "REQUEST_STATS", "NOTIFY_LIST", "NOTIFY_PUT",
    "POLICY_GET", "TUNNELS", "ZABBIX_METRICS", "SILENCE_LIST", "CLUSTER_DATASET", "BADGE",
    "ENABLE_NET_ERRORS", "ACTIVITY_LIST", "PINS", "ABORT_REQUESTS", "OPEN_APP",
];

/// One thing somebody did, already reduced to what may be written down.
#[derive(Clone, Debug, Default)]
pub struct ActivityEvent {
    pub action: String,
    pub ok: bool,
    pub reason: Option<String>,
    pub error_code: Option<String>,
    pub user: Option<String>,
    pub role: Option<String>,
    pub target_user: Option<String>,
    pub source_ip: Option<IpAddr>,
    pub cluster: Option<String>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub query: Option<String>,
    pub via: String,
    pub edition: String,
}

fn category(action: &str) -> &'static str {
    match action {
        "login" | "logout" | "sso_exchange" | "sso_zabbix" | "bootstrap_admin" => "authentication",
        a if a.starts_with("user_") || a.starts_with("token_") => "iam",
        "es" | "prime" | "forget" => "database",
        a if a.starts_with("config_") || a.starts_with("zabbix_") || a.starts_with("policy_")
            || a.starts_with("delay_sink_") || a.starts_with("key_") || a.starts_with("trust_")
            || a.starts_with("untrust_") || a == "file_write" || a == "write_unlock" => "configuration",
        _ => "process",
    }
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

impl ActivityEvent {
    /// The event for one exchange, or `None` for a background poll that went through. A
    /// poll that failed or was refused (a scoped user turned away from CLUSTER_DATASET, a
    /// dead session) is somebody probing and is recorded like anything else.
    pub fn from_exchange(
        msg: &Value, caller: Option<&Caller>, via: &str, source: Option<IpAddr>, reply: &Value, edition: Edition,
    ) -> Option<ActivityEvent> {
        let t = msg.get("type").and_then(Value::as_str).unwrap_or("");
        let ok = reply.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if t.is_empty() || (ok && POLLS.contains(&t)) {
            return None;
        }
        let s = |k: &str| msg.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());

        // A sign-in has no caller going in; the reply says who it made. A failed one has
        // neither, so the name that was typed is recorded — a run of them is the point.
        let reply_caller = reply.get("caller");
        let user = caller.map(|c| c.name.clone())
            .or_else(|| reply_caller.and_then(|c| c.get("name")).and_then(Value::as_str).map(String::from))
            .or_else(|| if t == "LOGIN" || t == "BOOTSTRAP_ADMIN" { s("name").map(|n| clip(n, 64)) } else { None });
        let role = caller.map(|c| c.role.as_str().to_string())
            .or_else(|| reply_caller.and_then(|c| c.get("role")).and_then(Value::as_str).map(String::from));

        let (mut path, mut query) = (None, None);
        if t == "ES" {
            if let Some(p) = s("path") {
                match p.split_once('?') {
                    Some((a, q)) => { path = Some(clip(a, 512)); query = Some(clip(q, 512)); }
                    None => path = Some(clip(p, 512)),
                }
            }
        }
        Some(ActivityEvent {
            action: t.to_ascii_lowercase(),
            ok,
            reason: if ok { None } else { reply.get("message").and_then(Value::as_str).map(|m| clip(m, 300)) },
            error_code: if ok { None } else { reply.get("errorCode").and_then(Value::as_str).map(String::from) },
            user,
            role,
            // Whose account an administrator is changing. A name, never a credential.
            target_user: if t.starts_with("USER_") { s("name").map(|n| clip(n, 64)) } else { None },
            source_ip: source,
            cluster: s("clusterId").map(|c| clip(c, 128)),
            method: if t == "ES" { Some(s("method").unwrap_or("GET").to_ascii_uppercase()) } else { None },
            path,
            query,
            via: via.to_string(),
            edition: edition_name(edition).to_string(),
        })
    }

    /// ECS-shaped, nested. `@timestamp` is stamped here, when the event is written.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("@timestamp".into(), json!(rfc3339_now()));
        o.insert("event".into(), json!({
            "kind": "event",
            "category": [category(&self.action)],
            "action": self.action,
            "outcome": if self.ok { "success" } else { "failure" },
            "reason": self.reason,
        }));
        if let Some(c) = &self.error_code { o.insert("error".into(), json!({ "code": c })); }
        let mut user = Map::new();
        if let Some(n) = &self.user { user.insert("name".into(), json!(n)); }
        if let Some(r) = &self.role { user.insert("roles".into(), json!([r])); }
        if let Some(t) = &self.target_user { user.insert("target".into(), json!({ "name": t })); }
        if !user.is_empty() { o.insert("user".into(), Value::Object(user)); }
        if let Some(ip) = self.source_ip { o.insert("source".into(), json!({ "ip": ip.to_string() })); }
        if let Some(m) = &self.method { o.insert("http".into(), json!({ "request": { "method": m } })); }
        if self.path.is_some() {
            o.insert("url".into(), json!({ "path": self.path, "query": self.query }));
        }
        o.insert("elasticpro".into(), json!({ "cluster": self.cluster, "via": self.via, "edition": self.edition }));
        o.insert("service".into(), json!({ "name": "elasticpro", "version": env!("CARGO_PKG_VERSION") }));
        // Absent is absent: a null in a SIEM mapping is a field that exists and is empty.
        strip_nulls(&mut o);
        Value::Object(o)
    }
}

fn strip_nulls(m: &mut Map<String, Value>) {
    m.retain(|_, v| !v.is_null());
    for v in m.values_mut() {
        if let Value::Object(inner) = v { strip_nulls(inner); }
    }
}

fn edition_name(e: Edition) -> &'static str {
    match e { Edition::Portable => "portable", Edition::Installed => "installed", Edition::Hosted => "hosted" }
}

/// Where the log goes and how it turns over.
#[derive(Clone, Debug)]
pub struct ActivityConfig {
    pub path: Option<PathBuf>,
    pub max_bytes: u64,
    pub keep: usize,
    pub stdout: bool,
}

impl ActivityConfig {
    /// From the environment. Off for the portable build unless a path is given: it has no
    /// one to account for, and it must not start writing beside the exe on its own.
    pub fn from_env(data_dir: Option<&Path>, edition: Edition) -> ActivityConfig {
        let var = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let path = match var("ELASTICPRO_ACTIVITY_LOG") {
            Some(v) if v.eq_ignore_ascii_case("off") => None,
            Some(v) => Some(PathBuf::from(v)),
            None if edition == Edition::Portable => None,
            None => data_dir.map(|d| d.join(FILE_NAME)),
        };
        ActivityConfig {
            path,
            max_bytes: var("ELASTICPRO_ACTIVITY_LOG_MAX_MB").and_then(|v| v.parse::<u64>().ok()).unwrap_or(DEFAULT_MAX_MB).max(1) * 1024 * 1024,
            keep: var("ELASTICPRO_ACTIVITY_LOG_KEEP").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_KEEP),
            stdout: var("ELASTICPRO_ACTIVITY_STDOUT").is_some_and(|v| v == "1"),
        }
    }
}

enum Msg {
    Line(String),
    /// Answered once everything queued before it has been written.
    Flush(SyncSender<()>),
}

pub struct ActivityLog {
    cfg: ActivityConfig,
    ring: Mutex<VecDeque<Value>>,
    tx: Option<SyncSender<Msg>>,
    dropped: AtomicU64,
    last_drop_warn: Mutex<Option<Instant>>,
}

impl ActivityLog {
    pub fn new(cfg: ActivityConfig) -> ActivityLog {
        let tx = cfg.path.clone().and_then(|path| {
            let (tx, rx) = sync_channel::<Msg>(QUEUE);
            let w = Writer { cfg: cfg.clone(), path: path.clone(), file: None, size: 0, warned: false };
            match std::thread::Builder::new().name("activity-writer".into()).spawn(move || w.run(rx)) {
                Ok(_) => Some(tx),
                Err(e) => {
                    tracing::warn!(error = %e, path = %path.display(), "activity log writer did not start; the log is kept in memory only");
                    None
                }
            }
        });
        Self::with_sender(cfg, tx)
    }

    fn with_sender(cfg: ActivityConfig, tx: Option<SyncSender<Msg>>) -> ActivityLog {
        ActivityLog { cfg, ring: Mutex::new(VecDeque::new()), tx, dropped: AtomicU64::new(0), last_drop_warn: Mutex::new(None) }
    }

    /// The file events are written to, if any.
    pub fn path(&self) -> Option<&Path> {
        self.cfg.path.as_deref()
    }

    /// Lines that never reached the writer because its queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn record(&self, ev: ActivityEvent) {
        let v = ev.to_json();
        let mut line = v.to_string();
        line.push('\n');
        if self.cfg.stdout {
            tracing::info!(target: "activity", event = %line.trim_end(), "activity");
        }
        {
            let mut ring = self.ring.lock();
            if ring.len() == RING { ring.pop_front(); }
            ring.push_back(v);
        }
        let Some(tx) = &self.tx else { return };
        match tx.try_send(Msg::Line(line)) {
            Ok(()) => {}
            // The writer has gone (it never does while this log lives); nothing to do.
            Err(TrySendError::Disconnected(_)) => {}
            Err(TrySendError::Full(_)) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                let mut last = self.last_drop_warn.lock();
                if last.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
                    *last = Some(Instant::now());
                    tracing::warn!(dropped_total = n, "activity log writer is behind; lines are being dropped from the file (the Accounts page still has them)");
                }
            }
        }
    }

    /// Wait until every line recorded so far has been handed to the file. For tests and
    /// for a clean shutdown; a request never calls it.
    pub fn flush(&self) {
        let Some(tx) = &self.tx else { return };
        let (ack, wait) = sync_channel::<()>(1);
        if tx.send(Msg::Flush(ack)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(10));
        }
    }

    /// Newest first. `user` is a case-insensitive substring of the user name.
    pub fn list(&self, limit: usize, user: Option<&str>, failed_only: bool) -> Vec<Value> {
        let want = user.map(|u| u.trim().to_lowercase()).filter(|u| !u.is_empty());
        self.ring.lock().iter().rev()
            .filter(|e| !failed_only || e["event"]["outcome"] == "failure")
            .filter(|e| want.as_ref().is_none_or(|w| e["user"]["name"].as_str().is_some_and(|n| n.to_lowercase().contains(w.as_str()))))
            .take(limit)
            .cloned()
            .collect()
    }
}

/// The thread that owns the file.
struct Writer {
    cfg: ActivityConfig,
    path: PathBuf,
    file: Option<File>,
    size: u64,
    warned: bool,
}

impl Writer {
    fn run(mut self, rx: Receiver<Msg>) {
        // Ends when the log is dropped and the last sender with it.
        while let Ok(m) = rx.recv() {
            match m {
                Msg::Line(l) => match self.append(l.as_bytes()) {
                    Ok(()) => self.warned = false,
                    Err(e) => {
                        // Once: a full disk would otherwise write a warning per click.
                        if !self.warned {
                            self.warned = true;
                            tracing::warn!(error = %e, path = %self.path.display(), "activity log is not being written; requests carry on");
                        }
                        self.file = None;
                    }
                },
                Msg::Flush(ack) => { let _ = ack.send(()); }
            }
        }
    }

    fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.file.is_none() {
            let (f, size) = open(&self.path)?;
            self.file = Some(f);
            self.size = size;
        }
        if self.size > 0 && self.size + bytes.len() as u64 > self.cfg.max_bytes {
            self.file = None;
            rotate(&self.path, self.cfg.keep)?;
            let (f, size) = open(&self.path)?;
            self.file = Some(f);
            self.size = size;
        }
        let f = self.file.as_mut().expect("opened above");
        // One write call per line, so a reader tailing the file never sees half of one.
        f.write_all(bytes)?;
        f.flush()?;
        self.size += bytes.len() as u64;
        Ok(())
    }
}

/// Open for append (mode 0600 on creation) and report the size. A non-empty file that
/// does not end in a newline is finished off with one first.
fn open(path: &Path) -> std::io::Result<(File, u64)> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(path)?;
    let mut size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size > 0 {
        let mut last = [0u8; 1];
        let mut r = File::open(path)?;
        r.seek(SeekFrom::Start(size - 1))?;
        r.read_exact(&mut last)?;
        if last[0] != b'\n' {
            f.write_all(b"\n")?;
            f.flush()?;
            size += 1;
        }
    }
    Ok((f, size))
}

fn numbered(path: &Path, n: usize) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(format!(".{n}"));
    PathBuf::from(s)
}

/// activity.jsonl -> .1 -> .2 ... -> .keep, and whatever was in .keep is gone.
fn rotate(path: &Path, keep: usize) -> std::io::Result<()> {
    if keep == 0 {
        return std::fs::remove_file(path);
    }
    let _ = std::fs::remove_file(numbered(path, keep));
    for n in (1..keep).rev() {
        let from = numbered(path, n);
        if from.exists() {
            std::fs::rename(&from, numbered(path, n + 1))?;
        }
    }
    std::fs::rename(path, numbered(path, 1))
}

/// RFC 3339, UTC, milliseconds. No date library in this crate and one is not worth adding
/// for a format this fixed.
fn rfc3339_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    rfc3339(d.as_secs() as i64, d.subsec_millis())
}

fn rfc3339(secs: i64, ms: u32) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(name: &str, role: crate::auth::Role) -> Caller {
        Caller { name: name.into(), role, must_change: false, scope: None }
    }

    fn ev(msg: Value, c: Option<&Caller>, reply: Value) -> Option<ActivityEvent> {
        ActivityEvent::from_exchange(&msg, c, "session", Some("10.1.2.3".parse().unwrap()), &reply, Edition::Hosted)
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ep-activity-{tag}-{}-{}", std::process::id(), crate::auth::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cfg(path: Option<PathBuf>, max_bytes: u64, keep: usize) -> ActivityConfig {
        ActivityConfig { path, max_bytes, keep, stdout: false }
    }

    #[test]
    fn timestamp_is_rfc3339_utc() {
        assert_eq!(rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(1_709_210_096, 42), "2024-02-29T12:34:56.042Z");
    }

    #[test]
    fn an_es_read_carries_the_ecs_keys() {
        let c = caller("asha", crate::auth::Role::User);
        let v = ev(json!({ "type": "ES", "clusterId": "prod", "method": "get", "path": "/_cat/indices?v=true" }), Some(&c), json!({ "ok": true }))
            .unwrap().to_json();
        assert!(v["@timestamp"].as_str().unwrap().ends_with('Z'));
        assert_eq!(v["event"]["kind"], "event");
        assert_eq!(v["event"]["category"], json!(["database"]));
        assert_eq!(v["event"]["action"], "es");
        assert_eq!(v["event"]["outcome"], "success");
        assert_eq!(v["user"]["name"], "asha");
        assert_eq!(v["user"]["roles"], json!(["user"]));
        assert_eq!(v["source"]["ip"], "10.1.2.3");
        assert_eq!(v["elasticpro"]["cluster"], "prod");
        assert_eq!(v["elasticpro"]["via"], "session");
        assert_eq!(v["http"]["request"]["method"], "GET");
        assert_eq!(v["url"]["path"], "/_cat/indices");
        assert_eq!(v["url"]["query"], "v=true");
        assert_eq!(v["service"]["name"], "elasticpro");
        assert_eq!(v["service"]["version"], env!("CARGO_PKG_VERSION"));
        assert!(v["event"].get("reason").is_none(), "absent fields are left out, not null");
    }

    #[test]
    fn a_failed_login_keeps_the_name_and_never_the_password() {
        let msg = json!({ "type": "LOGIN", "name": "  mallory  ", "password": "hunter2-secret", "session": "tok-abc", "text": "t", "secret": "s" });
        let e = ev(msg, None, json!({ "ok": false, "kind": "bad_credentials", "message": "no (E-AUTH)", "errorCode": "E-AUTH" })).unwrap();
        let line = e.to_json().to_string();
        assert!(!line.contains("hunter2") && !line.contains("tok-abc"), "{line}");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["user"]["name"], "mallory");
        assert_eq!(v["event"]["category"], json!(["authentication"]));
        assert_eq!(v["event"]["outcome"], "failure");
        assert_eq!(v["error"]["code"], "E-AUTH");
        assert!(v["event"]["reason"].as_str().unwrap().contains("no"));
    }

    #[test]
    fn user_changes_are_iam_and_name_the_target_not_the_password() {
        let c = caller("root", crate::auth::Role::Admin);
        let v = ev(json!({ "type": "USER_ADD", "name": "bob", "password": "pw-pw-pw-pw-pw", "role": "user" }), Some(&c), json!({ "ok": true })).unwrap().to_json();
        assert_eq!(v["event"]["category"], json!(["iam"]));
        assert_eq!(v["user"]["target"]["name"], "bob");
        assert!(!v.to_string().contains("pw-pw"));
    }

    #[test]
    fn polls_that_succeed_are_not_recorded() {
        for t in POLLS {
            assert!(ev(json!({ "type": t }), None, json!({ "ok": true })).is_none(), "{t}");
        }
        assert!(ev(json!({ "type": "REFRESH" }), None, json!({ "ok": true })).is_some());
    }

    #[test]
    fn a_poll_that_failed_is_recorded() {
        let c = caller("asha", crate::auth::Role::User);
        for t in ["CLUSTER_DATASET", "ZABBIX_METRICS", "FLEET_STATE"] {
            let e = ev(json!({ "type": t }), Some(&c), json!({ "ok": false, "kind": "forbidden", "message": "no (EP-110)", "errorCode": "EP-110" }))
                .unwrap_or_else(|| panic!("{t} refused must be recorded"));
            assert!(!e.ok);
            assert_eq!(e.action, t.to_ascii_lowercase());
            assert_eq!(e.error_code.as_deref(), Some("EP-110"));
        }
    }

    #[test]
    fn ring_is_capped_and_newest_first() {
        let log = ActivityLog::new(cfg(None, 1 << 20, 1));
        for i in 0..(RING + 5) {
            log.record(ActivityEvent { action: "es".into(), ok: true, user: Some(format!("u{i}")), ..Default::default() });
        }
        let all = log.list(usize::MAX, None, false);
        assert_eq!(all.len(), RING);
        assert_eq!(all[0]["user"]["name"], format!("u{}", RING + 4));
        assert_eq!(all[RING - 1]["user"]["name"], "u5");
        assert_eq!(log.list(3, Some("U10"), false).len(), 3);
    }

    #[test]
    fn failures_only_filter() {
        let log = ActivityLog::new(cfg(None, 1 << 20, 1));
        log.record(ActivityEvent { action: "es".into(), ok: true, ..Default::default() });
        log.record(ActivityEvent { action: "es".into(), ok: false, ..Default::default() });
        assert_eq!(log.list(10, None, true).len(), 1);
    }

    #[test]
    fn rotation_keeps_n_files_and_the_file_is_private() {
        let d = tmp("rot");
        let p = d.join(FILE_NAME);
        let log = ActivityLog::new(cfg(Some(p.clone()), 600, 2));
        for i in 0..40 {
            log.record(ActivityEvent { action: "es".into(), ok: true, user: Some(format!("u{i}")), ..Default::default() });
        }
        log.flush();
        assert!(p.exists() && numbered(&p, 1).exists() && numbered(&p, 2).exists());
        assert!(!numbered(&p, 3).exists(), "only two rotated files are kept");
        for f in [p.clone(), numbered(&p, 1)] {
            for l in std::fs::read_to_string(&f).unwrap().lines() {
                serde_json::from_str::<Value>(l).expect("every line is whole JSON");
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn an_unwritable_path_does_not_stop_recording() {
        let d = tmp("bad");
        let log = ActivityLog::new(cfg(Some(d.join("no-such-dir").join(FILE_NAME)), 1 << 20, 1));
        log.record(ActivityEvent { action: "es".into(), ok: true, ..Default::default() });
        log.flush();
        assert_eq!(log.list(10, None, false).len(), 1);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_reopened_file_with_a_half_line_gets_its_newline_first() {
        let d = tmp("repair");
        let p = d.join(FILE_NAME);
        std::fs::write(&p, "{\"half\":\"written").unwrap();
        let log = ActivityLog::new(cfg(Some(p.clone()), 1 << 20, 1));
        log.record(ActivityEvent { action: "es".into(), ok: true, user: Some("whole".into()), ..Default::default() });
        log.flush();
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(serde_json::from_str::<Value>(lines[0]).is_err(), "the broken line stays on its own");
        assert_eq!(serde_json::from_str::<Value>(lines[1]).unwrap()["user"]["name"], "whole");
        // A file that already ends in a newline is left alone.
        drop(log);
        let log = ActivityLog::new(cfg(Some(p.clone()), 1 << 20, 1));
        log.record(ActivityEvent { action: "es".into(), ok: true, ..Default::default() });
        log.flush();
        assert_eq!(std::fs::read_to_string(&p).unwrap().lines().count(), 3);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_full_queue_drops_and_counts_without_blocking() {
        let d = tmp("full");
        let (tx, rx) = sync_channel::<Msg>(2);
        let log = ActivityLog::with_sender(cfg(Some(d.join(FILE_NAME)), 1 << 20, 1), Some(tx));
        for _ in 0..5 {
            log.record(ActivityEvent { action: "es".into(), ok: true, ..Default::default() });
        }
        assert_eq!(log.dropped(), 3);
        assert_eq!(log.list(10, None, false).len(), 5, "the ring still has every event");
        assert_eq!(rx.try_iter().count(), 2);
        let _ = std::fs::remove_dir_all(d);
    }
}
