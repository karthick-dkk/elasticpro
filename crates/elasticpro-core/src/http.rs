//! Elasticsearch HTTP transport with exact error reporting.
//!
//! A browser's `fetch()` hides *why* a connection failed. Here every failure is
//! classified — refused, timed out, DNS, TLS untrusted (with the certificate to look
//! at), pin mismatch, tunnel down (with the tunnel's own reason) — and the response
//! carries a `kind` the UI can act on, plus a one-line `help`.

use crate::guard::{write_guard, Writes};
use crate::ssh::{Tunnel, TunnelState};
use crate::tls::{PinStore, PinningVerifier, TlsMode, MARK_PIN_MISMATCH, MARK_UNTRUSTED};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSpec {
    pub id: String,
    /// The name people know it by. Only used to name what the core creates for it — a
    /// Zabbix host — never to find it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub url: String,
    #[serde(default)]
    pub auth_header: Option<String>,
    /// jump host id, or none for a direct route
    #[serde(default)]
    pub via: Option<String>,
    #[serde(default)]
    pub tls: Option<String>,
    /// Zabbix user groups whose members may see this cluster. Only a scoped account — a
    /// Zabbix User — reads it; see `auth::scope_allows`.
    #[serde(default)]
    pub zabbix_groups: Vec<String>,
    /// The config's `logIndexPattern`: which indices the ILM-assignment check reads. The
    /// fleet poller builds the same request the page used to, so it needs the same input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_index_pattern: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsRequest {
    pub cluster_id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// `Some` = override (also `Some(None)`-like empty string for "no auth" probes);
    /// absent = use the primed credential.
    #[serde(default)]
    pub auth_header: Option<String>,
    /// Set only for a request a person asked for in the UI (a console request, a snapshot
    /// action). On its own it grants nothing — the session must also be unlocked
    /// (`WRITE_UNLOCK`). See `guard`.
    #[serde(default)]
    pub allow_writes: bool,
    /// Who asked: `poller:<key>`, `page:<id>`, `console`, … Recorded with the request and
    /// carried to Elasticsearch as `X-Opaque-Id`, so a query of ours can be found in the
    /// cluster's task list and told apart from everyone else's.
    #[serde(default)]
    pub origin: Option<String>,
    /// Set by the core for each request it sends; never read from the wire.
    #[serde(skip)]
    pub opaque_id: Option<String>,
    /// The signed-in person behind a page's request, set by the core from the session;
    /// never read from the wire. Recorded with the request, and part of the abort key so
    /// one person leaving a page cannot cancel another's requests from the same page.
    #[serde(skip)]
    pub user: Option<String>,
    /// How old an answer from the read cache may be, in milliseconds. `0` asks the cluster
    /// whatever is cached (the Reload button); absent takes ES_READ_CACHE_SECONDS. It can
    /// only shorten that, never lengthen it.
    #[serde(default)]
    pub max_age_ms: Option<u64>,
    /// Who this request is for, decided by the code path that built it — `es()` for a
    /// person, the poller and the core's own jobs for themselves. Never read from the wire:
    /// `origin` is the client's to name, and a page calling itself `poller:x` stays a page.
    #[serde(skip)]
    pub class: crate::gate::Class,
    /// Set only by the ES task reaper, for a `POST /_tasks/<id>/_cancel` on a task it has
    /// just verified as ours and read-only. See `guard::Writes::VerifiedTaskCancel`. Never
    /// read from the wire, and even when set it permits that one path shape and nothing else.
    #[doc(hidden)]
    #[serde(skip)]
    pub verified_cancel: bool,
}

impl Default for EsRequest {
    fn default() -> EsRequest {
        EsRequest {
            cluster_id: String::new(),
            url: None,
            method: default_method(),
            path: default_path(),
            body: None,
            timeout_ms: None,
            auth_header: None,
            allow_writes: false,
            origin: None,
            opaque_id: None,
            user: None,
            max_age_ms: None,
            class: crate::gate::Class::default(),
            verified_cancel: false,
        }
    }
}

fn default_method() -> String {
    "GET".into()
}
fn default_path() -> String {
    "/".into()
}

struct CachedClient {
    client: reqwest::Client,
    verifier: Arc<PinningVerifier>,
    signature: String,
}

pub struct Transport {
    pins: Arc<PinStore>,
    clients: Mutex<HashMap<String, Arc<CachedClient>>>,
}

pub struct Route<'a> {
    pub tunnel: Option<(&'a Arc<Tunnel>, u16)>,
    pub tls: TlsMode,
}

/// Response bytes being read from clusters at once, all requests together, counted in KiB.
///
/// A body is charged before it is read when its length is declared, and chunk by chunk
/// when it is not, and the charge is given back when the request is done. One answer
/// larger than the whole budget is refused rather than waited for: it could never fit.
pub struct ByteBudget {
    sem: Arc<tokio::sync::Semaphore>,
    total_kib: u32,
}

const KIB: u64 = 1024;

impl ByteBudget {
    pub fn new(bytes: u64) -> ByteBudget {
        let total_kib = (bytes / KIB).clamp(1024, u32::MAX as u64 / 2) as u32;
        ByteBudget { sem: Arc::new(tokio::sync::Semaphore::new(total_kib as usize)), total_kib }
    }
    pub fn total_bytes(&self) -> u64 {
        self.total_kib as u64 * KIB
    }
    pub fn in_use_bytes(&self) -> u64 {
        (self.total_kib as u64).saturating_sub(self.sem.available_permits() as u64) * KIB
    }
}

/// How much of an answer a request may bring back, and where the bytes are charged.
pub struct BodyLimit<'a> {
    pub cap_bytes: u64,
    /// The config.txt key that sets `cap_bytes`, for the refusal's hint.
    pub setting: &'static str,
    pub budget: Option<&'a ByteBudget>,
}

impl BodyLimit<'_> {
    /// No cap and no budget: for callers that read small, known answers.
    pub fn unlimited() -> BodyLimit<'static> {
        BodyLimit { cap_bytes: u64::MAX, setting: "", budget: None }
    }
}

/// Why a body was not read to the end.
enum BodyStop {
    /// Bigger than the cap (`declared` when Content-Length said so up front).
    TooLarge { declared: Option<u64> },
    /// Bigger than the whole in-flight budget.
    OverBudget,
    /// The deadline passed while waiting for budget.
    BudgetWait,
    Transport(reqwest::Error),
}

fn mb(b: u64) -> String {
    format!("{:.0} MB", b as f64 / (1024.0 * 1024.0))
}

/// The two refusals that need no socket: a path the URL parser would rewrite, and a write
/// the guard does not allow. Checked here and again by `request`, which is the chokepoint;
/// the core asks first so a refused request never waits for a slot.
pub fn refuse_early(req: &EsRequest, base_url: &str, writes: Writes) -> Option<Value> {
    let method = req.method.to_ascii_uppercase();
    let path = if req.path.starts_with('/') { req.path.clone() } else { format!("/{}", req.path) };
    let full = format!("{}{path}", base_url.trim_end_matches('/'));
    // Whitespace and control characters are dropped or rewritten by the URL parser, so the
    // path that was checked would not be the path that was sent. No real request needs
    // them raw; the UI percent-encodes what it sends.
    if path.chars().any(|c| c.is_ascii_control() || c.is_whitespace()) {
        return Some(json!({ "ok": false, "status": 0, "kind": "bad_request", "url": full, "tookMs": 0,
                            "message": "the path holds a space or a control character — percent-encode it" }));
    }
    write_guard(writes, &method, &path).map(|msg| json!({ "ok": false, "status": 0, "kind": "blocked_readonly", "message": msg, "url": full, "tookMs": 0 }))
}

/// Read a body in chunks, stopping at the cap, charging the byte budget as it goes.
async fn read_body(res: &mut reqwest::Response, limit: &BodyLimit<'_>, deadline: Instant, head: bool) -> Result<Vec<u8>, BodyStop> {
    // A HEAD answer's Content-Length is the size its GET would have; no body follows.
    let declared = if head { None } else { res.content_length() };
    if let Some(n) = declared {
        if n > limit.cap_bytes {
            return Err(BodyStop::TooLarge { declared: Some(n) });
        }
    }
    let mut held: Option<tokio::sync::OwnedSemaphorePermit> = None;
    let mut held_kib: u32 = 0;
    // Charge `want` bytes in all, waiting for budget no later than the deadline.
    async fn charge(b: &ByteBudget, held: &mut Option<tokio::sync::OwnedSemaphorePermit>, held_kib: &mut u32, want: u64, deadline: Instant) -> Result<(), BodyStop> {
        let want_kib = want.div_ceil(KIB).max(1);
        if want_kib > b.total_kib as u64 {
            return Err(BodyStop::OverBudget);
        }
        let more = want_kib as u32 - (*held_kib).min(want_kib as u32);
        if more == 0 {
            return Ok(());
        }
        let p = tokio::time::timeout_at(deadline.into(), b.sem.clone().acquire_many_owned(more)).await
            .map_err(|_| BodyStop::BudgetWait)?
            .map_err(|_| BodyStop::BudgetWait)?;
        match held {
            Some(h) => h.merge(p),
            None => *held = Some(p),
        }
        *held_kib += more;
        Ok(())
    }
    if let Some(b) = limit.budget {
        charge(b, &mut held, &mut held_kib, declared.unwrap_or(64 * KIB), deadline).await?;
    }
    let mut buf: Vec<u8> = Vec::with_capacity(declared.unwrap_or(16 * KIB).min(8 * 1024 * KIB) as usize);
    loop {
        let chunk = match tokio::time::timeout_at(deadline.into(), res.chunk()).await {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(BodyStop::Transport(e)),
            // reqwest's own timeout covers the body; this is its backstop.
            Err(_) => return Err(BodyStop::BudgetWait),
        };
        let total = buf.len() as u64 + chunk.len() as u64;
        if total > limit.cap_bytes {
            return Err(BodyStop::TooLarge { declared: None });
        }
        if let Some(b) = limit.budget {
            if total > held_kib as u64 * KIB {
                // Grow by doubling, so a long body is charged in a handful of steps.
                let want = total.max(held_kib as u64 * KIB * 2).min(limit.cap_bytes).max(total);
                charge(b, &mut held, &mut held_kib, want, deadline).await?;
            }
        }
        buf.extend_from_slice(&chunk);
    }
    drop(held);
    Ok(buf)
}

pub fn host_key(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => format!(
            "{}:{}",
            u.host_str().unwrap_or(""),
            u.port_or_known_default().unwrap_or(9200)
        ),
        Err(_) => url.to_string(),
    }
}

impl Transport {
    pub fn new(pins: Arc<PinStore>) -> Transport {
        Transport { pins, clients: Mutex::new(HashMap::new()) }
    }

    pub fn forget_clients(&self) {
        self.clients.lock().clear();
    }

    fn client_for(&self, cluster: &str, url: &str, route: &Route<'_>) -> Result<Arc<CachedClient>, String> {
        let hk = host_key(url);
        let signature = format!("{hk}|{:?}|{:?}", route.tls, route.tunnel.map(|(_, p)| p));
        if let Some(c) = self.clients.lock().get(cluster) {
            if c.signature == signature {
                return Ok(c.clone());
            }
        }
        let verifier = PinningVerifier::new(self.pins.clone(), route.tls, hk);
        let mut b = reqwest::Client::builder()
            .use_preconfigured_tls(verifier.client_config())
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::limited(3))
            .no_proxy()
            .user_agent(format!("ElasticPro-Desktop/{}", crate::VERSION));
        if let Some((_, port)) = route.tunnel {
            b = b.proxy(reqwest::Proxy::all(format!("socks5h://127.0.0.1:{port}")).map_err(|e| e.to_string())?);
        }
        let client = b.build().map_err(|e| e.to_string())?;
        let cc = Arc::new(CachedClient { client, verifier, signature });
        self.clients.lock().insert(cluster.to_string(), cc.clone());
        Ok(cc)
    }

    /// Send one request and read its answer, within `limit`.
    pub async fn request(
        &self,
        req: &EsRequest,
        base_url: &str,
        auth: Option<&str>,
        writes: Writes,
        route: Route<'_>,
        limit: &BodyLimit<'_>,
    ) -> Value {
        let method = req.method.to_ascii_uppercase();
        let path = if req.path.starts_with('/') { req.path.clone() } else { format!("/{}", req.path) };
        let base = base_url.trim_end_matches('/');
        let full = format!("{base}{path}");

        if let Some(refused) = refuse_early(req, base_url, writes) {
            return refused;
        }
        if let Some((t, _)) = route.tunnel {
            // fail fast with the tunnel's own words if it is known to be down and backing off
            if let TunnelState::Down { error, kind } = t.state() {
                if t.backing_off() {
                    return tunnel_failure(&full, t, &error, &kind);
                }
            }
        }
        let cc = match self.client_for(&req.cluster_id, base, &route) {
            Ok(c) => c,
            Err(e) => return json!({ "ok": false, "status": 0, "kind": "client_error", "message": e, "url": full, "tookMs": 0 }),
        };
        let m = match reqwest::Method::from_bytes(method.as_bytes()) {
            Ok(m) => m,
            Err(_) => return json!({ "ok": false, "status": 0, "kind": "bad_method", "message": format!("bad method {method}"), "url": full }),
        };
        let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(15000));
        let mut rb = cc
            .client
            .request(m.clone(), &full)
            .timeout(timeout)
            .header("Accept", "application/json");
        if let Some(id) = req.opaque_id.as_deref() {
            rb = rb.header("X-Opaque-Id", id);
        }
        if let Some(a) = auth.filter(|a| !a.is_empty()) {
            rb = rb.header("Authorization", a);
        }
        if let Some(body) = req.body.as_ref().filter(|_| m != reqwest::Method::GET && m != reqwest::Method::HEAD) {
            rb = rb.header("Content-Type", content_type(&path, body)).body(body.clone());
        }
        let started = Instant::now();
        match rb.send().await {
            Ok(mut res) => {
                let status = res.status();
                let body = read_body(&mut res, limit, started + timeout + Duration::from_secs(1), m == reqwest::Method::HEAD).await;
                drop(res);
                let took = started.elapsed().as_millis() as u64;
                let body = match body {
                    Ok(b) => b,
                    Err(BodyStop::Transport(e)) => {
                        let mut out = classify(&e, &full, &cc, route.tunnel.map(|(t, _)| t));
                        out["tookMs"] = json!(took);
                        return out;
                    }
                    Err(BodyStop::BudgetWait) => {
                        return json!({ "ok": false, "status": 0, "kind": "timeout", "url": full, "tookMs": took,
                            "message": "Request timed out while waiting for memory to read the answer into",
                            "help": "Many large answers were being read at once. Try again; if it keeps happening, narrow the request." });
                    }
                    Err(BodyStop::OverBudget) => {
                        return json!({ "ok": false, "status": 0, "httpStatus": status.as_u16(), "kind": "response_too_large", "url": full, "tookMs": took,
                            "limitBytes": limit.budget.map(|b| b.total_bytes()),
                            "message": format!("the answer is larger than the {} ElasticPro may hold in answers at once; nothing of it is shown",
                                               mb(limit.budget.map(|b| b.total_bytes()).unwrap_or(0))),
                            "help": "Narrow the request (filter_path, a smaller size, fewer indices). The budget is a share of the core's memory limit (CORE_MEM_LIMIT)." });
                    }
                    Err(BodyStop::TooLarge { declared }) => {
                        let mut out = json!({ "ok": false, "status": 0, "httpStatus": status.as_u16(), "kind": "response_too_large", "url": full, "tookMs": took,
                            "limitBytes": limit.cap_bytes,
                            "message": format!("the answer is larger than {}{}; it was not read, and nothing of it is shown", mb(limit.cap_bytes),
                                               declared.map(|d| format!(" (the cluster announced {})", mb(d))).unwrap_or_default()),
                            "help": format!("Narrow the request (filter_path, a smaller size, fewer indices){}.",
                                            if limit.setting.is_empty() { String::new() } else { format!(", or raise {} in config.txt", limit.setting) }) });
                        if let Some(d) = declared {
                            out["declaredBytes"] = json!(d);
                        }
                        return out;
                    }
                };
                let ok = status.is_success();
                let mut out = json!({
                    "ok": ok, "status": status.as_u16(), "statusText": status.canonical_reason().unwrap_or(""),
                    "tookMs": took, "url": full, "kind": if ok { "ok" } else { "http_error" },
                    "message": if ok { String::new() } else { format!("HTTP {} {}", status.as_u16(), status.canonical_reason().unwrap_or("")) },
                    "bytes": body.len(),
                });
                // Parsed straight from the bytes: no second copy of the body as text unless
                // it is not JSON.
                match serde_json::from_slice::<Value>(&body) {
                    Ok(j) => out["json"] = j,
                    Err(_) => {
                        out["json"] = Value::Null;
                        out["text"] = Value::String(String::from_utf8_lossy(&body).into_owned());
                    }
                }
                out
            }
            Err(e) => {
                let took = started.elapsed().as_millis() as u64;
                let mut out = classify(&e, &full, &cc, route.tunnel.map(|(t, _)| t));
                out["tookMs"] = json!(took);
                out
            }
        }
    }
}

/// The ndjson endpoints are decided by the endpoint, not by what the body looks like:
/// every `_msearch` / `_bulk` body begins with a `{` header line, so sniffing the first
/// character labels them `application/json` and Elasticsearch refuses them.
fn content_type(path: &str, body: &str) -> &'static str {
    let bare = path.split('?').next().unwrap_or("");
    let ndjson_endpoint = bare
        .rsplit('/')
        .find(|seg| !seg.is_empty())
        .map(|last| matches!(last, "_bulk" | "_msearch"))
        .unwrap_or(false)
        || bare.ends_with("_msearch/template")
        || bare.ends_with("_bulk/stream");
    if ndjson_endpoint {
        return "application/x-ndjson";
    }
    if body.trim_start().starts_with('{') || body.trim_start().starts_with('[') {
        "application/json"
    } else {
        "application/x-ndjson"
    }
}

fn tunnel_failure(url: &str, t: &Arc<Tunnel>, error: &str, kind: &str) -> Value {
    let mut v = json!({
        "ok": false, "status": 0, "url": url, "kind": "tunnel_error", "tunnelKind": kind,
        "message": format!("Jump host {}: {}", t.spec.id, error),
        "tunnel": t.status_json(None),
        "help": tunnel_help(kind),
    });
    if kind == "hostkey_unknown" || kind == "hostkey_mismatch" {
        if let Some((fp, kt)) = t.offered_hostkey() {
            v["hostKey"] = json!({ "jumpId": t.spec.id, "fingerprint": fp, "keyType": kt,
                                   "pinned": t.status_json(None)["hostKeyPinned"] });
        }
    }
    v
}

fn tunnel_help(kind: &str) -> &'static str {
    match kind {
        "hostkey_unknown" => "First contact with this jump host. Compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the jump host, then Trust it.",
        "hostkey_mismatch" => "The jump host presents a different key than the one pinned. Either it was reinstalled (untrust the old key in Config → Trust) or something sits between you and it.",
        "passphrase_needed" => "The private key is encrypted. Enter its passphrase — it is kept in memory for this session only.",
        "passphrase_wrong" => "That passphrase did not decrypt the key. Try again.",
        "auth_failed" => "The jump host did not accept the key. Check the user name, that the public key is in that user's authorized_keys, and that the key file is the matching private half.",
        "key_unreadable" => "The key file could not be read or parsed. OpenSSH (id_ed25519 / id_rsa) format is expected; PuTTY .ppk must be exported to OpenSSH format first.",
        "no_auth" => "Give the jump host a keyFile (or a session password) in clusters.yaml.",
        "connect" => "TCP to the jump host's SSH port failed. Firewall, wrong host/port, or the jump host is down.",
        "forward" => "The SSH session is up but the jump host refused to open a connection to the cluster: PermitOpen / permitopen restrictions, or the cluster is unreachable from there.",
        _ => "",
    }
}

fn classify(e: &reqwest::Error, url: &str, cc: &CachedClient, tunnel: Option<&Arc<Tunnel>>) -> Value {
    let dbg = format!("{e:?}");
    let chain = {
        let mut s = e.to_string();
        let mut src: Option<&dyn std::error::Error> = std::error::Error::source(e);
        while let Some(x) = src {
            s.push_str(" | ");
            s.push_str(&x.to_string());
            src = x.source();
        }
        s
    };
    let hk = cc.verifier_key();
    let cert = cc.verifier_pins().last_seen(&hk);
    let lower = chain.to_lowercase();

    let (kind, message, help): (&str, String, &str) = if e.is_timeout() {
        ("timeout", "Request timed out".into(), "No answer in time. The cluster may be slow, or a firewall drops packets silently.")
    } else if dbg.contains(MARK_UNTRUSTED) || lower.contains(MARK_UNTRUSTED.to_lowercase().as_str()) {
        ("tls_untrusted",
         "The certificate is not trusted by the OS store and has not been pinned yet.".into(),
         "Press Trust to pin this certificate (SHA-256 shown). The app will then accept exactly this certificate for this address, and refuse a different one.")
    } else if dbg.contains(MARK_PIN_MISMATCH) || lower.contains(MARK_PIN_MISMATCH.to_lowercase().as_str()) {
        ("tls_pin_mismatch",
         "The certificate CHANGED since it was pinned. Credential not sent.".into(),
         "If the certificate was rotated on purpose, untrust the old pin (Config → Trust) and trust the new one. If not, stop and check the path to this cluster.")
    } else if lower.contains("proxy") || lower.contains("socks") {
        let (m, k) = match tunnel {
            Some(t) => match t.state() {
                TunnelState::Down { error, kind } => (error, kind),
                TunnelState::Connecting => ("still connecting".to_string(), "connecting".into()),
                _ => ("could not open a connection to the cluster through the jump host".to_string(), "forward".into()),
            },
            None => ("SOCKS proxy failure".into(), "socks".into()),
        };
        if let Some(t) = tunnel {
            return tunnel_failure(url, t, &m, &k);
        }
        ("tunnel_error", m, "")
    } else if lower.contains("certificate") || lower.contains("handshake") || lower.contains("tls") || lower.contains("ssl") {
        ("tls_error", format!("TLS handshake failed: {}", short(&chain)),
         "The server and the app could not agree on TLS (version/cipher), or the certificate is malformed. Check xpack.security.http.ssl.supported_protocols.")
    } else if lower.contains("connection refused") {
        ("connection_refused", "Connection refused — nothing is listening on that port.".into(), "Not a certificate problem. Check the port and that Elasticsearch is running.")
    } else if lower.contains("dns") || lower.contains("failed to lookup") || lower.contains("name or service not known") || lower.contains("no such host") {
        ("dns", "DNS cannot resolve that hostname.".into(), "For a cluster behind a jump host the name is resolved ON the jump host; use the name or IP the jump host knows.")
    } else if lower.contains("unreachable") || lower.contains("no route") {
        ("unreachable", "No route to that address from this machine.".into(), "Wrong network, or this cluster should be routed via a jump host (`via:` in clusters.yaml).")
    } else if lower.contains("reset") || lower.contains("broken pipe") || lower.contains("eof") || lower.contains("connection closed") {
        ("connection_reset", "The connection was closed before an HTTP response.".into(), "Often plain HTTP sent to a TLS port or the reverse — check the scheme.")
    } else if e.is_connect() {
        ("network", format!("Could not connect: {}", short(&chain)), "")
    } else {
        ("unknown", short(&chain), "")
    };

    let mut v = json!({ "ok": false, "status": 0, "url": url, "kind": kind, "message": message, "help": help, "detail": short(&chain) });
    if kind == "tls_untrusted" || kind == "tls_pin_mismatch" || kind == "tls_error" {
        if let Some(c) = cert {
            v["cert"] = serde_json::to_value(&c).unwrap_or(Value::Null);
        }
        if let Some(pin) = cc.verifier_pins().cert_pin(&hk) {
            v["pinned"] = json!(pin.sha256);
        }
    }
    v
}

fn short(s: &str) -> String {
    let s = s.replace('\n', " ");
    if s.len() > 300 { format!("{}…", &s[..300]) } else { s }
}

impl CachedClient {
    fn verifier_key(&self) -> String {
        self.verifier.key().to_string()
    }
    fn verifier_pins(&self) -> &Arc<PinStore> {
        self.verifier.pins()
    }
}
