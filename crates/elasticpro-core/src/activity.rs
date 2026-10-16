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
//! Writing must never hurt the request it describes. An I/O error warns once and the log
//! carries on (and retries the file on the next event); the append is one small
//! synchronous write under a lock, which is cheaper than handing it to another thread.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::auth::{Caller, Edition};

/// Events the Accounts page can ask for. Older ones are still in the file.
pub const RING: usize = 1000;
pub const DEFAULT_MAX_MB: u64 = 50;
pub const DEFAULT_KEEP: usize = 5;
pub const FILE_NAME: &str = "activity.jsonl";

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
    /// The event for one exchange, or `None` for a background poll.
    pub fn from_exchange(
        msg: &Value, caller: Option<&Caller>, via: &str, source: Option<IpAddr>, reply: &Value, edition: Edition,
    ) -> Option<ActivityEvent> {
        let t = msg.get("type").and_then(Value::as_str).unwrap_or("");
        if t.is_empty() || POLLS.contains(&t) {
            return None;
        }
        let s = |k: &str| msg.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
        let ok = reply.get("ok").and_then(Value::as_bool).unwrap_or(false);

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

struct Inner {
    file: Option<File>,
    size: u64,
    ring: VecDeque<Value>,
    warned: bool,
}

pub struct ActivityLog {
    cfg: ActivityConfig,
    inner: Mutex<Inner>,
}

impl ActivityLog {
    pub fn new(cfg: ActivityConfig) -> ActivityLog {
        ActivityLog { cfg, inner: Mutex::new(Inner { file: None, size: 0, ring: VecDeque::new(), warned: false }) }
    }

    /// The file events are written to, if any.
    pub fn path(&self) -> Option<&Path> {
        self.cfg.path.as_deref()
    }

    pub fn record(&self, ev: ActivityEvent) {
        let v = ev.to_json();
        let mut line = v.to_string();
        line.push('\n');
        let mut g = self.inner.lock();
        if g.ring.len() == RING { g.ring.pop_front(); }
        g.ring.push_back(v);
        if self.cfg.stdout {
            tracing::info!(target: "activity", event = %line.trim_end(), "activity");
        }
        if let Some(p) = &self.cfg.path {
            if let Err(e) = self.append(&mut g, p, line.as_bytes()) {
                // Once: a full disk would otherwise write a warning per click.
                if !g.warned {
                    g.warned = true;
                    tracing::warn!(error = %e, path = %p.display(), "activity log is not being written; requests carry on");
                }
                g.file = None;
            } else {
                g.warned = false;
            }
        }
    }

    fn append(&self, g: &mut Inner, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        if g.file.is_none() {
            g.file = Some(open(path)?);
            g.size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }
        if g.size > 0 && g.size + bytes.len() as u64 > self.cfg.max_bytes {
            g.file = None;
            rotate(path, self.cfg.keep)?;
            g.file = Some(open(path)?);
            g.size = 0;
        }
        let f = g.file.as_mut().expect("opened above");
        // One write call per line, so a reader tailing the file never sees half of one.
        f.write_all(bytes)?;
        f.flush()?;
        g.size += bytes.len() as u64;
        Ok(())
    }

    /// Newest first. `user` is a case-insensitive substring of the user name.
    pub fn list(&self, limit: usize, user: Option<&str>, failed_only: bool) -> Vec<Value> {
        let want = user.map(|u| u.trim().to_lowercase()).filter(|u| !u.is_empty());
        self.inner.lock().ring.iter().rev()
            .filter(|e| !failed_only || e["event"]["outcome"] == "failure")
            .filter(|e| want.as_ref().is_none_or(|w| e["user"]["name"].as_str().is_some_and(|n| n.to_lowercase().contains(w.as_str()))))
            .take(limit)
            .cloned()
            .collect()
    }
}

fn open(path: &Path) -> std::io::Result<File> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
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
    fn polls_are_not_recorded() {
        for t in POLLS {
            assert!(ev(json!({ "type": t }), None, json!({ "ok": true })).is_none(), "{t}");
        }
        assert!(ev(json!({ "type": "REFRESH" }), None, json!({ "ok": true })).is_some());
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
        assert_eq!(log.list(10, None, false).len(), 1);
        let _ = std::fs::remove_dir_all(d);
    }
}
