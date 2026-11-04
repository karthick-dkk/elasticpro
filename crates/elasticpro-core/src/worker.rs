//! The report worker (docs/WORKER.md): one image, two roles.
//!
//! `ELASTICPRO_ROLE` decides what the bridge binary starts. `core` serves people and the
//! monitoring; `worker` runs the batch work — the daily volume collection, the report timer
//! and queue, the hosts collection, report builds and mail — on an internal port only; `all`
//! (unset) is everything in one process, exactly as before 0.3.54.
//!
//! What is here is pure or nearly so, and tested on its own: the role and what it starts, the
//! shared secret both containers agree on (`<data>/worker/token`, made once whoever starts
//! first), the worker's own gate caps, the HTTP client the core forwards with, and the
//! replies (`worker_unavailable`, `worker_version`). The core's side is `bridge/worker_api.rs`.
//!
//! Nothing here sends a cluster anything.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The worker's internal port. Never routed by nginx.
pub const PORT: u16 = 8766;
/// Where the core finds the worker when `ELASTICPRO_WORKER_URL` does not say.
pub const DEFAULT_URL: &str = "http://worker:8766";
/// `<data>/worker/`: the token, the status file, the requests ring.
pub const DIR: &str = "worker";
pub const TOKEN_FILE: &str = "worker/token";
pub const REQUESTS_FILE: &str = "worker/requests.jsonl";
/// Lines the requests ring keeps.
pub const REQUESTS_KEEP: usize = 5000;
/// Seconds between two status writes.
pub const HEARTBEAT_SECS: u64 = 10;
/// How often the worker looks for settings the core changed (primed.json, pins.json,
/// cluster-secrets.json, the Zabbix link).
pub const RELOAD_SECS: u64 = 30;
/// Request headers between the two.
pub const TOKEN_HEADER: &str = "x-elasticpro-worker-token";
pub const VERSION_HEADER: &str = "x-elasticpro-version";
/// How long the core waits for the worker to accept an action (queueing is quick; the work
/// itself is never waited for).
pub const FORWARD_TIMEOUT_MS: u64 = 15_000;

/// What this process is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// People, the monitoring and every setting; the batch work is forwarded.
    Core,
    /// The batch work only, on the internal port.
    Worker,
    /// Everything, as before 0.3.54.
    #[default]
    All,
}

impl Role {
    /// `core`, `worker`, else `all` — an unknown word is `all`, never a container that starts
    /// nothing.
    pub fn parse(v: Option<&str>) -> Role {
        match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("core") => Role::Core,
            Some("worker") => Role::Worker,
            _ => Role::All,
        }
    }

    pub fn from_env() -> Role {
        Role::parse(std::env::var("ELASTICPRO_ROLE").ok().as_deref())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Core => "core",
            Role::Worker => "worker",
            Role::All => "all",
        }
    }

    /// This process runs the batch work itself (the report queue, the collections, mail).
    pub fn runs_batch(self) -> bool {
        self != Role::Core
    }

    /// This process serves people (the public HTTP, the message API).
    pub fn serves_people(self) -> bool {
        self != Role::Worker
    }
}

/// What the bridge binary starts for a role: the table of docs/WORKER.md.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Starts {
    pub delay_sink: bool,
    pub history_store: bool,
    pub housekeeping: bool,
    pub zabbix_sync: bool,
    pub fleet_poller: bool,
    pub volume_daily: bool,
    pub report_timer: bool,
    pub request_reaper: bool,
    pub zabbix_push: bool,
    pub health: bool,
    /// The UI and the message API, behind nginx.
    pub public_http: bool,
    /// Port 8766: `/run`, `/send-now`, `/stop`, `/queue`, `/health`.
    pub worker_http: bool,
    /// `worker/status.json` every 10 s, `worker/requests.jsonl`, the settings reload.
    pub worker_loops: bool,
}

pub fn starts(role: Role) -> Starts {
    let core = role.serves_people();
    let batch = role.runs_batch();
    Starts {
        delay_sink: core,
        history_store: core,
        housekeeping: core,
        zabbix_sync: core,
        fleet_poller: core,
        volume_daily: batch,
        report_timer: batch,
        request_reaper: core,
        zabbix_push: core,
        health: core,
        public_http: core,
        worker_http: role == Role::Worker,
        worker_loops: role == Role::Worker,
    }
}

/* ------------------------------------------ the token ------------------------------------------ */

/// Make `path` hold `make()`'s bytes unless it already holds something, and return what it
/// holds — race-safe: when two processes start at once, exactly one file wins and both read
/// the winner. The bytes go to a temporary file of this process's own (0600, synced), which is
/// then hard-linked into place: `link` fails when the name exists, so nothing is ever written
/// through, and a reader never sees a half-written file.
pub fn create_once(path: &Path, make: impl FnOnce() -> Vec<u8>) -> std::io::Result<Vec<u8>> {
    use std::io::Write as _;
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
        }
    }
    if let Ok(b) = std::fs::read(path) {
        if !b.is_empty() {
            return Ok(b);
        }
    }
    let bytes = make();
    let tmp = path.with_file_name(format!(".{}.{}.{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("f"),
                                          std::process::id(), crate::auth::random_hex(4)));
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => std::fs::read(path),
        Err(e) => Err(e),
    }
}

/// The shared secret: `<data>/worker/token`, 32 random bytes as hex, made by whichever
/// container starts first.
pub fn token(data: &Path) -> Result<String, String> {
    let p = data.join(TOKEN_FILE);
    let b = create_once(&p, || crate::auth::random_hex(32).into_bytes()).map_err(|e| format!("{}: {e}", p.display()))?;
    let t = String::from_utf8_lossy(&b).trim().to_string();
    if t.len() < 32 {
        return Err(format!("{}: the token is too short", p.display()));
    }
    Ok(t)
}

/// The worker's address, as the core reaches it.
pub fn url() -> String {
    std::env::var("ELASTICPRO_WORKER_URL").ok().map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string())
}

/* ------------------------------------------ the gate ------------------------------------------ */

/// Overall, per cluster and per jump host, when `ELASTICPRO_WORKER_GATE_*` does not say.
pub const GATE_CONCURRENCY: usize = 16;
pub const GATE_PER_CLUSTER: usize = 4;
pub const GATE_PER_JUMP_HOST: usize = 4;

/// The worker's own gate limits: its caps over the core's other settings (queue bounds and
/// timeouts). Every request the worker makes is Background, so no slot is held back from
/// people here — there are none.
pub fn worker_limits(base: &crate::gate::Limits, env: impl Fn(&str) -> Option<String>) -> crate::gate::Limits {
    let n = |k: &str, d: usize| env(k).and_then(|v| v.trim().parse::<usize>().ok()).filter(|v| *v > 0).unwrap_or(d);
    crate::gate::Limits {
        global: n("ELASTICPRO_WORKER_GATE_CONCURRENCY", GATE_CONCURRENCY),
        per_cluster: n("ELASTICPRO_WORKER_GATE_PER_CLUSTER", GATE_PER_CLUSTER),
        per_jump: n("ELASTICPRO_WORKER_GATE_PER_JUMP_HOST", GATE_PER_JUMP_HOST),
        background_reserve: 0,
        ..base.clone()
    }
    .normalised()
}

/* ------------------------------------------ the wire ------------------------------------------ */

/// Who asked, as the core vouches for them: the worker acts as this person (their name on the
/// job, their clusters).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCaller {
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub scope: Option<Vec<String>>,
}

impl WireCaller {
    pub fn of(c: &crate::auth::Caller) -> WireCaller {
        WireCaller { name: c.name.clone(), role: c.role.as_str().to_string(), scope: c.scope.clone() }
    }

    pub fn caller(&self) -> Option<crate::auth::Caller> {
        Some(crate::auth::Caller {
            name: self.name.clone(),
            role: crate::auth::Role::parse(&self.role)?,
            must_change: false,
            scope: self.scope.clone(),
            play: None,
        })
    }
}

/// One forwarded action.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    /// The message type (`REPORT_RUN`, `VOLUME_RUN`, `REPORT_SEND_NOW`, `REPORT_STOP`, …).
    #[serde(rename = "type")]
    pub kind: String,
    pub msg: Value,
    /// `None`: nobody signed in (the portable build has no accounts).
    #[serde(default)]
    pub caller: Option<WireCaller>,
}

/// Which endpoint a forwarded message goes to.
pub fn endpoint(t: &str) -> Option<&'static str> {
    match t {
        "REPORT_RUN" | "VOLUME_RUN" => Some("/run"),
        "REPORT_SEND_NOW" => Some("/send-now"),
        "REPORT_STOP" => Some("/stop"),
        "REPORT_CLEAR" | "REPORT_CONCURRENCY_SET" => Some("/queue"),
        _ => None,
    }
}

/// Which message types an endpoint takes (the worker refuses anything else there).
pub fn accepts(path: &str, t: &str) -> bool {
    endpoint(t) == Some(path)
}

pub const UNAVAILABLE_TEXT: &str = "the report worker is not running — reports and collection resume when it is back";

/// The core's answer when the worker cannot be reached. Monitoring is untouched; the last
/// heartbeat says since when.
pub fn unavailable(why: &str, heartbeat_at: Option<u64>) -> Value {
    let mut v = json!({ "ok": false, "kind": "worker_unavailable", "message": UNAVAILABLE_TEXT, "detail": why,
                        "lastHeartbeatAt": heartbeat_at });
    crate::errors::stamp(&mut v);
    v
}

/// The worker's answer to a core of another version: a half-upgraded stack never mixes
/// record formats.
pub fn version_refusal(worker: &str, core: &str) -> Value {
    let mut v = json!({ "ok": false, "kind": "worker_version",
        "message": format!("the report worker runs ElasticPro {worker} and the core {core}: finish the upgrade so both run the same version"),
        "workerVersion": worker, "coreVersion": core });
    crate::errors::stamp(&mut v);
    v
}

/// The worker's check of a request: the token first (401), then the version (409).
pub fn check(expected: &str, token: Option<&str>, version: Option<&str>, own_version: &str) -> Result<(), (u16, Value)> {
    let given = token.unwrap_or("");
    if expected.is_empty() || !crate::auth::ct_eq(expected.as_bytes(), given.as_bytes()) {
        return Err((401, json!({ "ok": false, "kind": "unauthenticated", "message": "the worker token is missing or wrong" })));
    }
    let v = version.unwrap_or("");
    if v != own_version {
        return Err((409, version_refusal(own_version, if v.is_empty() { "of an unknown version" } else { v })));
    }
    Ok(())
}

/// The HTTP client the core forwards with: plain HTTP on the internal network, no proxy.
fn client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().no_proxy().connect_timeout(std::time::Duration::from_secs(3))
        .build().unwrap_or_else(|_| reqwest::Client::new()))
}

/// Send one action to the worker. `Err` is "could not reach it" (the caller answers
/// `worker_unavailable`); any answer it gave, refusals included, is `Ok`.
pub async fn send(base: &str, token: &str, path: &str, body: &Value) -> Result<Value, String> {
    let r = client().post(format!("{base}{path}"))
        .header(TOKEN_HEADER, token).header(VERSION_HEADER, crate::VERSION)
        .timeout(std::time::Duration::from_millis(FORWARD_TIMEOUT_MS))
        .json(body).send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let v: Value = r.json().await.map_err(|e| format!("HTTP {status}: {e}"))?;
    if status == 401 {
        // The two do not share the data volume, or one of them made its own token.
        return Err(format!("the worker refused the token (HTTP 401): {}", v.get("message").and_then(Value::as_str).unwrap_or("")));
    }
    Ok(v)
}

/// `GET /health` of the worker.
pub async fn health(base: &str) -> Result<Value, String> {
    let r = client().get(format!("{base}/health")).timeout(std::time::Duration::from_secs(3)).send().await.map_err(|e| e.to_string())?;
    r.json().await.map_err(|e| e.to_string())
}

/* -------------------------------------- the requests ring -------------------------------------- */

/// The worker's finished requests, newest last, at most `REQUESTS_KEEP` lines. The core merges
/// them into the Request Centre, labelled *worker*.
#[derive(Default)]
pub struct RequestRing {
    lines: std::collections::VecDeque<String>,
    /// The highest request id already in `lines`.
    last_id: u64,
    dirty: bool,
}

impl RequestRing {
    /// Load what an earlier run left, so a restart keeps the ring.
    pub fn load(data: &Path) -> RequestRing {
        let mut r = RequestRing::default();
        if let Ok(t) = std::fs::read_to_string(data.join(REQUESTS_FILE)) {
            for l in t.lines().filter(|l| !l.trim().is_empty()) {
                r.lines.push_back(l.to_string());
            }
            while r.lines.len() > REQUESTS_KEEP {
                r.lines.pop_front();
            }
        }
        r
    }

    /// Add finished records (`id`, serialised record), oldest first; ids at or below the last
    /// one taken are skipped (a run's ids only grow).
    pub fn add(&mut self, recs: impl IntoIterator<Item = (u64, Value)>) {
        for (id, mut v) in recs {
            if id <= self.last_id {
                continue;
            }
            self.last_id = id;
            if let Some(o) = v.as_object_mut() {
                o.insert("process".into(), json!("worker"));
            }
            self.lines.push_back(v.to_string());
            self.dirty = true;
        }
        while self.lines.len() > REQUESTS_KEEP {
            self.lines.pop_front();
        }
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// Write the ring (temp + rename) when it changed.
    pub fn flush(&mut self, data: &Path) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        let mut body = String::with_capacity(self.lines.iter().map(|l| l.len() + 1).sum());
        for l in &self.lines {
            body.push_str(l);
            body.push('\n');
        }
        crate::volume::store::write_atomic(&data.join(REQUESTS_FILE), body.as_bytes())?;
        self.dirty = false;
        Ok(())
    }
}

/// The core's read of the ring: the newest `limit` records first, parsed. A file mid-rename is
/// read again once; lines that do not parse are left out.
pub fn read_requests(data: &Path, limit: usize) -> Vec<Value> {
    let p = data.join(REQUESTS_FILE);
    let text = std::fs::read_to_string(&p).or_else(|_| std::fs::read_to_string(&p)).unwrap_or_default();
    text.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).take(limit).collect()
}

/* ------------------------------------------ reading files ------------------------------------------ */

/// Read and parse a JSON file another process writes (temp + rename): a read that fails is
/// tried once more after a moment, the way a reader meets a file mid-rename. `Ok(None)`: the
/// file is not there.
pub fn read_json_retry<T: serde::de::DeserializeOwned>(p: &Path) -> Result<Option<T>, String> {
    for attempt in 0..2 {
        match std::fs::read(p) {
            Ok(b) => match serde_json::from_slice::<T>(&b) {
                Ok(v) => return Ok(Some(v)),
                Err(e) if attempt == 1 => return Err(format!("{}: {e}", p.display())),
                Err(_) => {}
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) if attempt == 1 => return Err(format!("{}: {e}", p.display())),
            Err(_) => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Ok(None)
}

/// A file's modification time, to notice that another process changed it.
pub fn mtime(p: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok())
}

/// Watches one file's modification time: `changed` is true the first time it is asked about
/// a time it has not seen (a file that appears, changes or goes).
#[derive(Default)]
pub struct Watch {
    seen: parking_lot::Mutex<Option<Option<std::time::SystemTime>>>,
}

impl Watch {
    /// A watch that has already seen the file as it is now.
    pub fn primed(p: &Path) -> Watch {
        Watch { seen: parking_lot::Mutex::new(Some(mtime(p))) }
    }

    pub fn changed(&self, p: &Path) -> bool {
        let now = mtime(p);
        let mut s = self.seen.lock();
        if s.as_ref() == Some(&now) {
            return false;
        }
        *s = Some(now);
        true
    }
}

/// `<data>/worker/`.
pub fn dir(data: &Path) -> PathBuf {
    data.join(DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("ep-worker-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_role_is_core_worker_or_all_and_says_what_starts() {
        assert_eq!(Role::parse(None), Role::All);
        assert_eq!(Role::parse(Some(" Worker ")), Role::Worker);
        assert_eq!(Role::parse(Some("core")), Role::Core);
        assert_eq!(Role::parse(Some("both")), Role::All, "an unknown word starts everything, never nothing");
        let all = starts(Role::All);
        assert!(all.fleet_poller && all.report_timer && all.volume_daily && all.public_http && all.health);
        assert!(!all.worker_http && !all.worker_loops, "role all runs no worker port");
        let core = starts(Role::Core);
        assert!(core.fleet_poller && core.delay_sink && core.history_store && core.housekeeping && core.zabbix_sync
            && core.request_reaper && core.zabbix_push && core.health && core.public_http);
        assert!(!core.report_timer && !core.volume_daily, "the core never starts the report timer in role core");
        assert!(!core.worker_http);
        let w = starts(Role::Worker);
        assert!(w.report_timer && w.volume_daily && w.worker_http && w.worker_loops);
        assert!(!w.public_http && !w.fleet_poller && !w.delay_sink && !w.history_store && !w.zabbix_push && !w.zabbix_sync,
                "the worker serves nobody and polls nothing");
    }

    #[test]
    fn two_processes_starting_at_once_agree_on_one_token() {
        let d = tmp();
        let handles: Vec<_> = (0..8).map(|_| {
            let d = d.clone();
            std::thread::spawn(move || token(&d).unwrap())
        }).collect();
        let got: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(got.iter().all(|t| t == &got[0]), "{got:?}");
        assert_eq!(got[0].len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(TOKEN_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let leftovers: Vec<_> = std::fs::read_dir(d.join(DIR)).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "no temporary file is left behind: {leftovers:?}");
        assert_eq!(token(&d).unwrap(), got[0], "read again, not made again");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn a_request_needs_the_token_and_the_same_version() {
        assert_eq!(check("abc", Some("abc"), Some("1.0"), "1.0"), Ok(()));
        assert_eq!(check("abc", Some("abd"), Some("1.0"), "1.0").unwrap_err().0, 401);
        assert_eq!(check("abc", None, Some("1.0"), "1.0").unwrap_err().0, 401);
        assert_eq!(check("", Some(""), Some("1.0"), "1.0").unwrap_err().0, 401, "no token on the worker: nobody gets in");
        let (code, v) = check("abc", Some("abc"), Some("0.9"), "1.0").unwrap_err();
        assert_eq!(code, 409);
        assert_eq!(v["kind"], "worker_version");
        assert!(v["message"].as_str().unwrap().contains("1.0") && v["message"].as_str().unwrap().contains("0.9"));
        assert_eq!(v["errorCode"], "EP-219");
        let u = unavailable("connection refused", Some(5));
        assert_eq!(u["kind"], "worker_unavailable");
        assert_eq!(u["lastHeartbeatAt"], 5);
        assert_eq!(u["errorCode"], "EP-218");
    }

    #[test]
    fn the_worker_gate_has_its_own_caps() {
        let base = crate::gate::Limits::default();
        let l = worker_limits(&base, |_| None);
        assert_eq!((l.global, l.per_cluster, l.per_jump, l.background_reserve), (16, 4, 4, 0));
        let l = worker_limits(&base, |k| (k == "ELASTICPRO_WORKER_GATE_PER_CLUSTER").then(|| "6".to_string()));
        assert_eq!(l.per_cluster, 6);
        assert_eq!(l.queue_wait_ms, base.queue_wait_ms, "the rest is the core's");
    }

    #[test]
    fn each_action_has_its_endpoint() {
        assert_eq!(endpoint("REPORT_RUN"), Some("/run"));
        assert_eq!(endpoint("VOLUME_RUN"), Some("/run"));
        assert_eq!(endpoint("REPORT_SEND_NOW"), Some("/send-now"));
        assert_eq!(endpoint("REPORT_STOP"), Some("/stop"));
        assert_eq!(endpoint("REPORT_CLEAR"), Some("/queue"));
        assert_eq!(endpoint("REPORT_JOBS"), None, "reads never go to the worker");
        assert!(accepts("/run", "VOLUME_RUN") && !accepts("/run", "REPORT_STOP"));
        let c = crate::auth::Caller { name: "ann".into(), role: crate::auth::Role::Operator, must_change: false, scope: Some(vec!["g".into()]), play: None };
        let back = WireCaller::of(&c).caller().unwrap();
        assert_eq!((back.name.as_str(), back.role, back.scope.clone()), ("ann", crate::auth::Role::Operator, Some(vec!["g".to_string()])));
    }

    #[test]
    fn the_requests_ring_keeps_the_newest_five_thousand() {
        let d = tmp();
        let mut r = RequestRing::default();
        r.add((1..=5003u64).map(|i| (i, json!({ "id": i, "cluster": "a" }))));
        r.add([(10u64, json!({ "id": 10 }))]);
        assert_eq!(r.len(), REQUESTS_KEEP);
        r.flush(&d).unwrap();
        let back = read_requests(&d, 3);
        assert_eq!(back[0]["id"], 5003, "newest first");
        assert_eq!(back[0]["process"], "worker");
        let again = RequestRing::load(&d);
        assert_eq!(again.len(), REQUESTS_KEEP);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn a_watch_notices_a_change_once() {
        let d = tmp();
        let f = d.join("x.json");
        let w = Watch::primed(&f);
        assert!(!w.changed(&f), "not there, and seen not there");
        std::fs::write(&f, b"{}").unwrap();
        assert!(w.changed(&f));
        assert!(!w.changed(&f));
        assert_eq!(read_json_retry::<Value>(&f).unwrap(), Some(json!({})));
        assert_eq!(read_json_retry::<Value>(&d.join("none.json")).unwrap(), None);
        std::fs::remove_dir_all(d).ok();
    }
}
