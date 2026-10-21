//! ElasticPro's own request figures, pushed to Zabbix.
//!
//! Once a minute the hosted core sends what the Request Centre shows — in flight and queued
//! per class, the wait p95, refusals by kind, answers shared and cached, requests per
//! minute, the memory budgets in use — as one JSON value to one trapper item,
//! `elasticpro.gate.raw`, on the Zabbix host named by `ZABBIX_METRICS_HOST`. The template
//! "ElasticPro request gate by Zabbix trapper" (Zabbix modules repository) splits it into
//! dependent items and alerts on it, including on the values stopping.
//!
//! * **Transport:** `history.push` over the Zabbix API connection the core already has
//!   (Config → Zabbix, or `ELASTICPRO_ZABBIX_API_URL` + `..._TOKEN_FILE`): its address and
//!   its TLS trust. No new endpoint, no `zabbix_sender` binary in the image. Zabbix 7.0 or
//!   later.
//! * **Which token.** The link's, unless `ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE` names a
//!   token of its own. The identity pairing creates ("ElasticPro sync") is a Super admin
//!   role allowed only read methods: it sees every host and can change nothing. Allowing it
//!   `history.push` too would let ElasticPro's token write values into any trapper item on
//!   any host. Whether that is acceptable is the operator's decision, so the core does not
//!   take it: it either uses the sync identity once someone has added `history.push` to its
//!   role, or a token for a user that may push and do nothing else, with read-write on the
//!   one host group that holds the metrics host. deploy/README.md has both recipes.
//! * **Off by default.** No host named, no task at all. A host named but the Zabbix API not
//!   configured: the timer runs (the API can be paired later from the UI) and calls
//!   nothing.
//! * **It writes to Zabbix, not to Elasticsearch,** so the "writes are gated twice" rule —
//!   which is about clusters — does not apply. Naming the host is the opt-in; the token's
//!   user needs write permission on that one host (see deploy/README.md).
//! * **Never in the way.** Its own task. The figures are read as a snapshot — each lock
//!   taken briefly, as the Request Centre takes it — and the push happens after every lock
//!   is let go. The call is bounded ([`PUSH_TIMEOUT`]), shares the Zabbix API's concurrency
//!   limit with the sync, and a failure backs off ([`backoff`]) rather than retrying hard.
//! * **Aggregates only.** No cluster name, id or address and no URL is in the value: it goes
//!   to a Zabbix whose readers need not be the people who may see every cluster. Per-cluster
//!   load stays in the Request Centre, which scopes it.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;

use crate::bridge::Core;
use crate::gate::{Load, Window};

/// The trapper item the value goes to. The template's master item has this key.
pub const MASTER_KEY: &str = "elasticpro.gate.raw";
/// The environment variable `ZABBIX_METRICS_HOST` (config.txt) becomes.
pub const HOST_ENV: &str = "ELASTICPRO_ZABBIX_METRICS_HOST";
/// A token for the push alone. Server-only, a file, like the other Zabbix tokens.
pub const TOKEN_FILE_ENV: &str = "ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE";
/// How often, and the window every count covers: each push is its own minute, so Zabbix can
/// add them up without counting anything twice.
pub const INTERVAL: Duration = Duration::from_secs(60);
/// The longest one push may take, waiting for a free Zabbix API slot included.
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(20);
/// The longest wait between attempts while pushes fail.
pub const MAX_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// The payload's shape. Raised only when a field changes meaning or goes away; adding one
/// does not.
pub const SCHEMA: u32 = 1;

/// The figures one push is built from. Filled by `Core::push_figures`.
#[derive(Clone, Debug, Default)]
pub struct Figures {
    /// Unix seconds the snapshot was taken.
    pub clock: u64,
    pub load: Load,
    pub window: Window,
    /// Requests sent to clusters in the window.
    pub sent: usize,
    pub global_limit: usize,
    pub queue_max: usize,
    pub queue_wait_ms: u64,
    /// The poller's policy mode (`auto`, `background`, `hybrid`, `on-demand`).
    pub policy_mode: &'static str,
    /// Every request paused (the Request Centre's Stop), and how many clusters are paused
    /// one by one — a count, not which.
    pub paused_all: bool,
    pub paused_clusters: usize,
    pub cache_used_bytes: u64,
    pub cache_budget_bytes: u64,
    pub inflight_used_bytes: u64,
    pub inflight_budget_bytes: u64,
    pub read_cache_used_bytes: u64,
    pub read_cache_budget_bytes: u64,
    /// The container's memory limit, when there is one.
    pub memory_limit_bytes: Option<u64>,
    /// How many clusters the core knows. A count, never their names.
    pub clusters: usize,
}

fn classes(a: [usize; 3]) -> Value {
    json!({ "interactive": a[0], "prompted": a[1], "background": a[2], "total": a.iter().sum::<usize>() })
}

/// A share of a budget as a percentage with one decimal, or `None` without a budget.
fn pused(used: u64, budget: u64) -> Option<f64> {
    (budget > 0).then(|| (used as f64 * 1000.0 / budget as f64).round() / 10.0)
}

/// The value pushed to [`MASTER_KEY`]. Pure, so the shape is tested.
///
/// Unknown is not zero: a wait p95 with no grant in the window to measure, a percentage with
/// no budget, a memory limit that does not exist are left out, not sent as 0. The
/// template's items discard a missing field instead of storing a guess.
pub fn payload(f: &Figures) -> Value {
    let w = &f.window;
    let mut p95 = Map::new();
    for (i, c) in crate::gate::Class::ALL.iter().enumerate() {
        if let Some(ms) = w.wait_p95_ms[i] {
            p95.insert(c.as_str().into(), json!(ms));
        }
    }
    let mut queued = classes(f.load.queued);
    queued["oldest_wait_ms"] = json!(f.load.oldest_wait_ms);
    let mut memory = json!({
        "cache_used_bytes": f.cache_used_bytes, "cache_budget_bytes": f.cache_budget_bytes,
        "inflight_used_bytes": f.inflight_used_bytes, "inflight_budget_bytes": f.inflight_budget_bytes,
        "read_cache_used_bytes": f.read_cache_used_bytes, "read_cache_budget_bytes": f.read_cache_budget_bytes,
    });
    if let Some(p) = pused(f.cache_used_bytes, f.cache_budget_bytes) {
        memory["cache_pused"] = json!(p);
    }
    if let Some(p) = pused(f.inflight_used_bytes, f.inflight_budget_bytes) {
        memory["inflight_pused"] = json!(p);
    }
    if let Some(l) = f.memory_limit_bytes {
        memory["limit_bytes"] = json!(l);
    }
    // Requests per minute, from a window that is normally exactly a minute.
    let per_min = (f.sent as u64).saturating_mul(60_000).checked_div(w.window_ms).unwrap_or(0);
    json!({
        "schema": SCHEMA,
        "version": crate::VERSION,
        "clock": f.clock,
        "window_s": w.window_ms / 1000,
        "inflight": classes(f.load.running),
        "queued": queued,
        "granted": classes(w.granted),
        "wait_p95_ms": p95,
        "refused": { "overloaded": w.overloaded, "queue_timeout": w.queue_timeout, "total": w.refused },
        "too_large": w.too_large,
        "shared": w.shared,
        "cached": w.cache_hits,
        "requests_per_min": per_min,
        "limits": { "global": f.global_limit, "queue_max": f.queue_max, "queue_wait_ms": f.queue_wait_ms },
        "policy": { "mode": f.policy_mode, "paused_all": u8::from(f.paused_all), "paused_clusters": f.paused_clusters },
        "memory": memory,
        "clusters": f.clusters,
    })
}

/// How long to wait before the next attempt after `consecutive` failures in a row: the
/// interval, doubled per failure, at most [`MAX_BACKOFF`]. 0 failures: the interval.
pub fn backoff(every: Duration, consecutive: u32) -> Duration {
    every.saturating_mul(1u32 << consecutive.min(16)).min(MAX_BACKOFF.max(every))
}

/// What the Request Centre shows about the push. Nothing secret: the host name is the
/// operator's own setting and the token is never in here.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushStatus {
    /// A host is named.
    pub enabled: bool,
    pub host: Option<String>,
    /// Why nothing is being pushed right now, when nothing is.
    pub idle: Option<String>,
    pub interval_secs: u64,
    /// Whose token signs the pushes: `link` (the Zabbix connection's) or `metrics` (its own,
    /// `ELASTICPRO_ZABBIX_METRICS_TOKEN_FILE`). Never the token.
    pub credential: Option<&'static str>,
    /// Unix ms.
    pub last_ok_at: Option<u64>,
    pub last_attempt_at: Option<u64>,
    pub pushes: u64,
    pub failures: u64,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub next_at: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A Zabbix host's technical name: letters, digits, spaces, dots, dashes, underscores.
pub fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 128 && h.chars().all(|c| c.is_ascii_alphanumeric() || " .-_".contains(c))
}

/// The setting, trimmed; `None` when unset or empty.
pub fn host_from_env() -> Option<String> {
    std::env::var(HOST_ENV).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Where the push's own token is, when it has one.
pub fn token_file_from_env() -> Option<std::path::PathBuf> {
    std::env::var_os(TOKEN_FILE_ENV).filter(|v| !v.is_empty()).map(std::path::PathBuf::from)
}

/// The push's own token, read afresh each time so a rotated file is picked up. `Err` when
/// the file is named but gives no token: that is a misconfiguration to report, not a
/// reason to fall back to another identity silently.
fn read_token(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if !t.trim().is_empty() => Ok(t.trim().to_string()),
        Ok(_) => Err(format!("{TOKEN_FILE_ENV} ({}) is empty", path.display())),
        Err(e) => Err(format!("{TOKEN_FILE_ENV} ({}) cannot be read: {e}", path.display())),
    }
}

impl Core {
    /// Start the push timer. Hosted only, and called once from the bridge binary, like the
    /// other timers. Does nothing at all unless `ZABBIX_METRICS_HOST` names a host.
    pub fn start_zabbix_push(self: &Arc<Self>) {
        if self.edition() != crate::auth::Edition::Hosted {
            return;
        }
        self.start_zabbix_push_with(host_from_env(), token_file_from_env(), INTERVAL);
    }

    /// The same with the host, the token file and the interval given. Tests use a short
    /// interval; the environment is one per process.
    #[doc(hidden)]
    pub fn start_zabbix_push_with(self: &Arc<Self>, host: Option<String>, token_file: Option<std::path::PathBuf>, every: Duration) {
        let Some(host) = host else {
            self.zbx_push.lock().idle = Some("ZABBIX_METRICS_HOST is not set".into());
            return;
        };
        if !valid_host(&host) {
            tracing::warn!(target: "audit", host = %host,
                           "zabbix push: ZABBIX_METRICS_HOST is not a Zabbix host name (letters, digits, space, . - _); not pushing");
            self.zbx_push.lock().idle = Some("ZABBIX_METRICS_HOST is not a valid Zabbix host name".into());
            return;
        }
        {
            let mut s = self.zbx_push.lock();
            s.enabled = true;
            s.host = Some(host.clone());
            s.interval_secs = every.as_secs();
            s.credential = Some(if token_file.is_some() { "metrics" } else { "link" });
            s.next_at = Some(now_ms() + every.as_millis() as u64);
        }
        tracing::info!(target: "audit", host = %host, every_secs = every.as_secs(), key = MASTER_KEY,
                       credential = if token_file.is_some() { "metrics" } else { "link" },
                       "zabbix push: request figures go to Zabbix by history.push");
        let core = self.clone();
        tokio::spawn(async move {
            let mut wait = every;
            loop {
                tokio::time::sleep(wait).await;
                wait = core.zabbix_push_once(&host, token_file.as_deref(), every).await;
                core.zbx_push.lock().next_at = Some(now_ms() + wait.as_millis() as u64);
            }
        });
    }

    /// One push. Returns how long to wait before the next.
    async fn zabbix_push_once(&self, host: &str, token_file: Option<&std::path::Path>, every: Duration) -> Duration {
        let zapi = self.zbx_api();
        // Not paired and no API configured: nothing to push to, whatever token there is.
        if zapi.url().is_none() || (token_file.is_none() && !zapi.configured()) {
            self.zbx_push.lock().idle = Some("the Zabbix API is not configured (Config → Zabbix)".into());
            return every;
        }
        let zapi = match token_file.map(read_token) {
            None => zapi,
            Some(Ok(token)) => Arc::new(self.zbx_api_with_token(token)),
            Some(Err(why)) => {
                tracing::warn!(target: "audit", error = %why, "zabbix push: not pushing");
                self.zbx_push.lock().idle = Some(why);
                return every;
            }
        };
        // Read, then let go of everything, then push.
        let figures = self.push_figures(every);
        let value = payload(&figures).to_string();
        let started = now_ms();
        let res = match tokio::time::timeout(PUSH_TIMEOUT, zapi.push_history(host, MASTER_KEY, &value, figures.clock)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) if e.message.contains("Incorrect method") => {
                Err(format!("{} — history.push needs Zabbix 7.0 or later", e.message))
            }
            Ok(Err(e)) => Err(e.message),
            Err(_) => Err(format!("no answer within {} s", PUSH_TIMEOUT.as_secs())),
        };
        let mut s = self.zbx_push.lock();
        s.idle = None;
        s.last_attempt_at = Some(started);
        match res {
            Ok(()) => {
                if s.consecutive_failures > 0 {
                    tracing::info!(target: "audit", host = %host, after = s.consecutive_failures, "zabbix push: working again");
                }
                s.pushes += 1;
                s.consecutive_failures = 0;
                s.last_ok_at = Some(now_ms());
                s.last_error = None;
                every
            }
            Err(why) => {
                s.failures += 1;
                s.consecutive_failures = s.consecutive_failures.saturating_add(1);
                let next = backoff(every, s.consecutive_failures);
                tracing::warn!(target: "audit", host = %host, error = %why, failures = s.consecutive_failures,
                               retry_in_secs = next.as_secs(), "zabbix push failed");
                s.last_error = Some(why);
                next
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn busy() -> Figures {
        Figures {
            clock: 1_790_000_000,
            load: Load { running: [3, 1, 2], queued: [4, 0, 1], oldest_wait_ms: 2_500 },
            window: Window {
                window_ms: 60_000, granted: [40, 5, 30],
                wait_p50_ms: [Some(10), Some(0), Some(0)], wait_p95_ms: [Some(1_800), None, Some(50)],
                overloaded: 2, queue_timeout: 1, refused: 3, too_large: 1, shared: 7, cache_hits: 9, cache_bytes: 4096,
            },
            sent: 120,
            global_limit: 4,
            queue_max: 64,
            queue_wait_ms: 20_000,
            policy_mode: "on-demand",
            paused_all: false,
            paused_clusters: 2,
            cache_used_bytes: 64 << 20,
            cache_budget_bytes: 256 << 20,
            inflight_used_bytes: 0,
            inflight_budget_bytes: 256 << 20,
            read_cache_used_bytes: 1 << 20,
            read_cache_budget_bytes: 64 << 20,
            memory_limit_bytes: Some(1 << 30),
            clusters: 32,
        }
    }

    #[test]
    fn the_payload_carries_every_figure_in_its_place() {
        let p = payload(&busy());
        assert_eq!(p["schema"], json!(SCHEMA));
        assert_eq!(p["version"], json!(crate::VERSION));
        assert_eq!(p["window_s"], json!(60));
        assert_eq!(p["inflight"], json!({ "interactive": 3, "prompted": 1, "background": 2, "total": 6 }));
        assert_eq!(p["queued"]["total"], json!(5));
        assert_eq!(p["queued"]["oldest_wait_ms"], json!(2_500));
        assert_eq!(p["wait_p95_ms"]["interactive"], json!(1_800));
        assert_eq!(p["refused"], json!({ "overloaded": 2, "queue_timeout": 1, "total": 3 }));
        assert_eq!(p["too_large"], json!(1));
        assert_eq!((p["shared"].clone(), p["cached"].clone()), (json!(7), json!(9)));
        assert_eq!(p["requests_per_min"], json!(120));
        assert_eq!(p["limits"], json!({ "global": 4, "queue_max": 64, "queue_wait_ms": 20_000 }));
        assert_eq!(p["policy"], json!({ "mode": "on-demand", "paused_all": 0, "paused_clusters": 2 }));
        assert_eq!(p["memory"]["cache_pused"], json!(25.0));
        assert_eq!(p["memory"]["inflight_pused"], json!(0.0));
        assert_eq!(p["memory"]["limit_bytes"], json!(1u64 << 30));
        assert_eq!(p["clusters"], json!(32));
    }

    #[test]
    fn unknown_is_left_out_not_sent_as_zero() {
        let mut f = busy();
        f.window.wait_p95_ms = [None, None, None];
        f.cache_budget_bytes = 0;
        f.memory_limit_bytes = None;
        let p = payload(&f);
        assert_eq!(p["wait_p95_ms"], json!({}), "no grant in the window: no p95, not 0");
        assert!(p["memory"].get("cache_pused").is_none());
        assert!(p["memory"].get("limit_bytes").is_none());
        // Prompted had no grant in the busy minute either.
        assert!(payload(&busy())["wait_p95_ms"].get("prompted").is_none());
    }

    #[test]
    fn the_payload_names_no_cluster_and_no_address() {
        // Whatever the core knows, the value is aggregates: the per-cluster maps the
        // Request Centre shows have no field here to go into.
        let text = payload(&busy()).to_string();
        for bad in ["://", "zbx-", "cluster\"", "url", "host", "token", "password", "Bearer", "byCluster"] {
            assert!(!text.contains(bad), "{bad:?} in {text}");
        }
        let keys: Vec<String> = payload(&busy()).as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 17, "a new top-level field is a decision, not an accident: {keys:?}");
    }

    #[test]
    fn requests_per_minute_scales_a_window_that_is_not_a_minute() {
        let mut f = busy();
        f.window.window_ms = 30_000;
        f.sent = 10;
        assert_eq!(payload(&f)["requests_per_min"], json!(20));
        f.window.window_ms = 0;
        assert_eq!(payload(&f)["requests_per_min"], json!(0));
    }

    #[test]
    fn failures_back_off_to_a_ceiling() {
        let m = Duration::from_secs(60);
        assert_eq!(backoff(m, 0), m);
        assert_eq!(backoff(m, 1), Duration::from_secs(120));
        assert_eq!(backoff(m, 3), Duration::from_secs(480));
        assert_eq!(backoff(m, 4), MAX_BACKOFF);
        assert_eq!(backoff(m, u32::MAX), MAX_BACKOFF);
        // A test interval below a second backs off from there.
        assert_eq!(backoff(Duration::from_millis(50), 2), Duration::from_millis(200));
    }

    #[test]
    fn host_names_are_zabbix_technical_names() {
        assert!(valid_host("ElasticPro"));
        assert!(valid_host("elasticpro core.prod-1_a"));
        assert!(!valid_host(""));
        assert!(!valid_host("http://zabbix/"));
        assert!(!valid_host("a,b"));
    }
}
