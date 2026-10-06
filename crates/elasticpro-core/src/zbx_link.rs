//! The Zabbix connection, configured from the UI (hosted edition).
//!
//! Before this, connecting ElasticPro to Zabbix meant environment variables and secret
//! files on the server: `ELASTICPRO_ZABBIX_API_URL`, `ELASTICPRO_ZABBIX_API_TOKEN_FILE`,
//! `ELASTICPRO_ZABBIX_SSO_SECRET_FILE`, a compose overlay, and an nginx edit for
//! `frame-ancestors`. Those still work, and they still win — field by field — over anything
//! set here. What this adds is a second source for the same fields, kept in
//! `$ELASTICPRO_DATA_DIR/zabbix-link.json` (0600, written tmp + rename), which an admin fills in
//! from Config → Zabbix, and a pairing handshake that lets the Zabbix module hand over its
//! API token without anybody copying a secret by hand:
//!
//! 1. An admin presses *Pair with Zabbix*. `begin_pair` makes a fresh SSO secret and a
//!    nonce that lives fifteen minutes, and returns them once, inside a **pairing code**:
//!    `base64url(JSON {v:1, ep, secret, nonce, exp})`.
//! 2. The admin pastes the code into the module in Zabbix. The module creates its API user
//!    and token, then posts `{nonce, zabbixUrl, apiUrl, apiToken, zabbixVersion, ts}` to
//!    `POST /zabbix/pair`, signed with the secret from the code by exactly the scheme the
//!    sign-in uses (`ZabbixSso::sign` / `signature_ok` — one implementation).
//! 3. `complete_pair` checks it and, only then, promotes the new secret to the one the
//!    sign-in verifies against. Until that moment the old secret keeps working, so
//!    re-pairing never breaks sign-in for the people already using it.
//!
//! What is never possible: reading a secret back. No message returns the API token or the
//! SSO secret; the status says `set`/`not set` and when and by whom. The only time a secret
//! leaves this process is the pairing code, once, to the admin who asked for it.
//!
//! Everything reads the effective settings through [`resolve`], so "does the env win" is
//! decided in one place.

use crate::zbx_sso::{ZabbixSso, MAX_SKEW_SECS, MIN_SECRET_LEN};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const LINK_FILE: &str = "zabbix-link.json";
/// How long a pairing code is good for.
pub const PAIR_TTL_SECS: u64 = 15 * 60;
pub const DEFAULT_SYNC_SECS: u64 = 300;
pub const MIN_SYNC_SECS: u64 = 30;
pub const MAX_SYNC_SECS: u64 = 86_400;
pub const MAX_SOURCES: usize = 64;
/// The pairing code's format version.
pub const CODE_VERSION: u64 = 1;
/// Random bytes in a pairing secret (43 characters of base64url).
pub const SECRET_BYTES: usize = 32;
/// Signed requests per source per minute, enforced by the core itself — nginx has its own
/// limit in front, but the module may also reach the core directly on the `ep_sso`
/// network, where nginx is not in the path.
pub const PAIR_PER_MIN: usize = 10;
pub const SSO_PER_MIN: usize = 120;
/// Audit events kept in the file for the status panel. The full record is the audit log.
const EVENTS_KEPT: usize = 30;

/// The fields a server setting can own. The names are the wire names.
pub const FIELDS: [&str; 7] = ["zabbixUrl", "apiUrl", "apiToken", "ssoSecret", "verifyTls", "allowedSources", "syncSecs"];

/* ------------------------------------ the file ------------------------------------ */

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkEvent {
    pub at: u64,
    pub by: String,
    pub action: String,
    pub ok: bool,
    /// What changed or why it failed. Never a secret.
    #[serde(default)]
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zabbix_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sso_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_tls: Option<bool>,
    /// An admin said plain http is acceptable (a lab). Shown as a warning while it is on.
    #[serde(default)]
    pub allow_http: bool,
    #[serde(default)]
    pub allowed_sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zabbix_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_set_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_set_by: Option<String>,
    #[serde(default)]
    pub events: Vec<LinkEvent>,
}

/* ------------------------------ what the server says ------------------------------ */

/// The server's own settings — environment and files. Each one present wins over the UI.
#[derive(Clone, Debug, Default)]
pub struct ServerZbx {
    pub zabbix_url: Option<String>,
    pub api_url: Option<String>,
    pub api_token: Option<String>,
    pub sso_secret: Option<String>,
    pub verify_tls: Option<bool>,
    pub allowed_sources: Option<Vec<String>>,
    pub sync_secs: Option<u64>,
    /// `ELASTICPRO_FRAME_ANCESTORS`: the CSP `frame-ancestors` value, verbatim.
    pub frame_ancestors: Option<String>,
    /// `ELASTICPRO_PUBLIC_URL`: the address the Zabbix module should call back, when the
    /// admin's browser does not see the one the module can reach.
    pub public_url: Option<String>,
    /// `ELASTICPRO_TRUSTED_PROXIES`: peers whose `X-Real-IP` is believed. Unset = any peer's.
    pub trusted_proxies: Option<Vec<String>>,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn file_env(k: &str) -> Option<String> {
    env(k).and_then(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn list(v: &str) -> Vec<String> {
    v.split([',', ' ', '\n']).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

impl ServerZbx {
    pub fn from_env() -> ServerZbx {
        ServerZbx {
            zabbix_url: env("ELASTICPRO_ZABBIX_URL"),
            api_url: env("ELASTICPRO_ZABBIX_API_URL"),
            api_token: file_env("ELASTICPRO_ZABBIX_API_TOKEN_FILE"),
            sso_secret: env("ELASTICPRO_ZABBIX_SSO_SECRET").or_else(|| file_env("ELASTICPRO_ZABBIX_SSO_SECRET_FILE")),
            verify_tls: env("ELASTICPRO_ZABBIX_API_INSECURE").filter(|v| v == "1").map(|_| false),
            allowed_sources: env("ELASTICPRO_ZABBIX_ALLOWED_SOURCES").map(|v| list(&v)),
            sync_secs: env("ELASTICPRO_ZABBIX_SYNC_SECS").and_then(|v| v.parse().ok()),
            frame_ancestors: env("ELASTICPRO_FRAME_ANCESTORS"),
            public_url: env("ELASTICPRO_PUBLIC_URL"),
            trusted_proxies: env("ELASTICPRO_TRUSTED_PROXIES").map(|v| list(&v)),
        }
    }

    /// Which fields the server owns.
    pub fn managed(&self) -> Vec<&'static str> {
        let mut m = vec![];
        let flags = [
            self.zabbix_url.is_some(), self.api_url.is_some(), self.api_token.is_some(), self.sso_secret.is_some(),
            self.verify_tls.is_some(), self.allowed_sources.is_some(), self.sync_secs.is_some(),
        ];
        for (f, on) in FIELDS.iter().zip(flags) {
            if on {
                m.push(*f);
            }
        }
        m
    }
}

/// The effective settings: server first, then the file, then the defaults.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resolved {
    pub zabbix_url: Option<String>,
    pub api_url: Option<String>,
    pub api_token: Option<String>,
    pub sso_secret: Option<String>,
    pub verify_tls: bool,
    pub allowed_sources: Vec<String>,
    pub sync_secs: u64,
    /// The whole CSP `frame-ancestors` source list.
    pub frame_ancestors: String,
}

/// The one resolution function. Everything that needs a Zabbix setting reads it from here.
pub fn resolve(server: &ServerZbx, file: &LinkFile) -> Resolved {
    let zabbix_url = server.zabbix_url.clone().or_else(|| file.zabbix_url.clone());
    let api_url = server.api_url.clone().or_else(|| file.api_url.clone())
        .or_else(|| zabbix_url.as_ref().map(|u| default_api_url(u)));
    let sso_secret = server.sso_secret.clone().or_else(|| file.sso_secret.clone());
    let frame_ancestors = match &server.frame_ancestors {
        Some(v) => sanitize_csp(v),
        None => match (&sso_secret, zabbix_url.as_deref().and_then(origin)) {
            (Some(_), Some(o)) => o,
            _ => "'none'".into(),
        },
    };
    Resolved {
        api_token: server.api_token.clone().or_else(|| file.api_token.clone()),
        verify_tls: server.verify_tls.or(file.verify_tls).unwrap_or(true),
        allowed_sources: server.allowed_sources.clone().unwrap_or_else(|| file.allowed_sources.clone()),
        sync_secs: server.sync_secs.or(file.sync_secs).unwrap_or(DEFAULT_SYNC_SECS).clamp(MIN_SYNC_SECS, MAX_SYNC_SECS),
        zabbix_url,
        api_url,
        sso_secret,
        frame_ancestors,
    }
}

/// A header value cannot carry a newline, and a CSP directive list cannot carry `;` without
/// starting another directive. Anything else in a server-set value is the operator's call.
fn sanitize_csp(v: &str) -> String {
    let first = v.split(';').next().unwrap_or("");
    let s: String = first.chars().filter(|c| !c.is_control() && *c != ',').collect();
    let s = s.trim().to_string();
    if s.is_empty() { "'none'".into() } else { s }
}

pub fn default_api_url(zabbix_url: &str) -> String {
    format!("{}/api_jsonrpc.php", zabbix_url.trim_end_matches('/'))
}

/* ----------------------------------- validation ----------------------------------- */

/// A Zabbix or ElasticPro address: absolute, http(s), no credentials, no query or fragment.
/// Plain http only when an admin allowed it. Returned without a trailing slash.
pub fn normalize_url(raw: &str, allow_http: bool) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("the address is empty".into());
    }
    if t.len() > 2048 {
        return Err("the address is longer than 2048 characters".into());
    }
    // The input is never echoed back: an address pasted with a password in it would
    // otherwise land in the answer, the events and the audit log.
    let u = reqwest::Url::parse(t).map_err(|e| format!("not an absolute URL ({e})"))?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err("the address must not carry a user name or password".into());
    }
    let host = u.host_str().unwrap_or("").to_string();
    match u.scheme() {
        "https" => {}
        "http" if allow_http => {}
        "http" => return Err(format!("http://{host} is plain http — use https, or tick \u{201c}allow plain http\u{201d} for a lab")),
        s => return Err(format!("the scheme must be https, not {s}")),
    }
    if host.is_empty() {
        return Err("the address has no host".into());
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err("the address must not carry a query string or fragment".into());
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}

/// `https://zbx.example.com:8443/zabbix/` → `https://zbx.example.com:8443`.
pub fn origin(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

/// Same scheme, host (any case) and port, the default port filled in.
pub fn same_origin(a: &str, b: &str) -> bool {
    matches!((origin(a), origin(b)), (Some(x), Some(y)) if x == y)
}

/// A Zabbix API token: Zabbix makes 64 hex characters; this accepts the characters any
/// bearer token uses, 16–512 of them, and nothing that could break a header.
pub fn valid_token(t: &str) -> bool {
    (16..=512).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || "-._~+/=".contains(c))
}

/// `10.0.0.5` or `10.0.0.0/24` or `fd00::/8`.
pub fn parse_source(s: &str) -> Result<(IpAddr, u8), String> {
    let s = s.trim();
    let (ip, len) = match s.split_once('/') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    let ip: IpAddr = ip.parse().map_err(|_| format!("{s:?} is not an IP address or CIDR"))?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    let len = match len {
        Some(l) => l.parse::<u8>().ok().filter(|l| *l <= max).ok_or_else(|| format!("{s:?}: the prefix must be 0–{max}"))?,
        None => max,
    };
    Ok((canon(ip), len))
}

fn canon(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

fn in_net(ip: IpAddr, net: IpAddr, len: u8) -> bool {
    match (canon(ip), net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let mask = if len == 0 { 0 } else { u32::MAX << (32 - len as u32) };
            (u32::from(a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let mask = if len == 0 { 0 } else { u128::MAX << (128 - len as u32) };
            (u128::from(a) & mask) == (u128::from(n) & mask)
        }
        _ => false,
    }
}

/// Whether `ip` is inside any entry. An entry that does not parse matches nothing.
pub fn source_allowed(list: &[String], ip: IpAddr) -> bool {
    list.iter().filter_map(|s| parse_source(s).ok()).any(|(n, l)| in_net(ip, n, l))
}

/* ---------------------------------- pairing code ---------------------------------- */

/// `base64url(JSON {v, ep, secret, nonce, exp})`, unpadded.
pub fn pairing_code(ep: &str, secret: &str, nonce: &str, exp: u64) -> String {
    use base64::Engine as _;
    let j = json!({ "v": CODE_VERSION, "ep": ep, "secret": secret, "nonce": nonce, "exp": exp });
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(j.to_string())
}

/// The JSON inside a pairing code — padded or not. For tests and for anyone checking one.
pub fn decode_pairing_code(code: &str) -> Option<Value> {
    use base64::Engine as _;
    let t = code.trim().trim_end_matches('=');
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(t).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn random_secret() -> String {
    use base64::Engine as _;
    use rand::RngCore;
    let mut b = [0u8; SECRET_BYTES];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/* ------------------------------------ pairing ------------------------------------ */

struct Pending {
    secret: String,
    nonce: String,
    zabbix_url: String,
    exp: u64,
    by: String,
}

/// What the module posts to `/zabbix/pair`. Unknown fields are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    nonce: String,
    zabbix_url: String,
    api_url: String,
    api_token: String,
    #[serde(default)]
    zabbix_version: String,
    ts: u64,
}

/// Why a pairing was refused. `status()` is the HTTP answer; before the signature has been
/// checked every refusal looks the same from outside.
#[derive(Debug, PartialEq)]
pub enum PairError {
    /// The source is not in `allowedSources`.
    Forbidden(String),
    /// Too many attempts from one source.
    RateLimited,
    /// No pairing is in progress, or the signature does not verify. One answer for both.
    Unauthorized(&'static str),
    /// Signed with the pairing secret, but refused — safe to say why.
    Refused { kind: &'static str, why: String },
}

impl PairError {
    pub fn status(&self) -> u16 {
        match self {
            PairError::Forbidden(_) => 403,
            PairError::RateLimited => 429,
            _ => 401,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            PairError::Forbidden(_) => "forbidden",
            PairError::RateLimited => "rate_limited",
            PairError::Unauthorized(_) => "unauthorized",
            PairError::Refused { kind, .. } => kind,
        }
    }

    /// What the caller is told.
    pub fn public_message(&self) -> String {
        match self {
            PairError::Forbidden(_) => "this source may not pair with ElasticPro".into(),
            PairError::RateLimited => "too many pairing attempts — wait a minute".into(),
            PairError::Unauthorized(_) => "pairing refused".into(),
            PairError::Refused { why, .. } => why.clone(),
        }
    }

    /// What the audit log is told — more than the caller, never a secret.
    pub fn audit_reason(&self) -> String {
        match self {
            PairError::Forbidden(s) => format!("source {s} is not in allowedSources"),
            PairError::RateLimited => "rate limited".into(),
            PairError::Unauthorized(r) => (*r).into(),
            PairError::Refused { kind, why } => format!("{kind}: {why}"),
        }
    }
}

/// A completed pairing, for the core to act on.
#[derive(Debug)]
pub struct Paired {
    pub secret: String,
    pub zabbix_url: String,
    pub api_url: String,
    pub zabbix_version: String,
    pub by: String,
}

/* ------------------------------------- store ------------------------------------- */

/// The link: the file, the server's settings over it, and the pairing in progress.
pub struct ZbxLink {
    path: Option<PathBuf>,
    server: ServerZbx,
    file: RwLock<LinkFile>,
    pending: Mutex<Option<Pending>>,
    /// Signatures of pairing bodies already seen, for the replay check.
    seen: Mutex<HashMap<String, Instant>>,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
    writing: Mutex<()>,
}

impl ZbxLink {
    pub fn open(path: Option<PathBuf>, server: ServerZbx) -> ZbxLink {
        let file = path.as_ref().and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<LinkFile>(&b).map_err(|e| tracing::warn!("ignoring {LINK_FILE}: {e}")).ok())
            .unwrap_or_default();
        ZbxLink {
            path,
            server,
            file: RwLock::new(file),
            pending: Mutex::new(None),
            seen: Mutex::new(HashMap::new()),
            hits: Mutex::new(HashMap::new()),
            writing: Mutex::new(()),
        }
    }

    pub fn server(&self) -> &ServerZbx {
        &self.server
    }

    pub fn resolved(&self) -> Resolved {
        resolve(&self.server, &self.file.read())
    }

    pub fn file_snapshot(&self) -> LinkFile {
        self.file.read().clone()
    }

    /// The file, written so that a crash leaves either the old one or the new one — and so
    /// that it is never readable by anybody else, not even for the moment between writing
    /// and renaming: the temporary file is created 0600.
    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        let _w = self.writing.lock();
        let body = serde_json::to_vec_pretty(&*self.file.read()).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        {
            use std::io::Write as _;
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{}: {e}", path.display())
        })
    }

    /// Record an event in the file and in the audit log.
    fn event(&self, by: &str, action: &str, ok: bool, detail: &str, source: Option<String>, now: u64) {
        tracing::info!(target: "audit", user = by, action = action, ok = ok, detail = detail,
                       source = source.as_deref().unwrap_or("-"), "zabbix link");
        let mut f = self.file.write();
        f.events.push(LinkEvent { at: now, by: by.to_string(), action: action.to_string(), ok, detail: detail.to_string(), source });
        let n = f.events.len();
        if n > EVENTS_KEPT {
            f.events.drain(..n - EVENTS_KEPT);
        }
    }

    /// Whether this source may make another request on this route now.
    pub fn rate_ok(&self, route: &str, source: Option<IpAddr>, per_min: usize) -> bool {
        let key = format!("{route}|{}", source.map(|s| s.to_string()).unwrap_or_else(|| "-".into()));
        let mut hits = self.hits.lock();
        let window = Duration::from_secs(60);
        hits.retain(|_, q| q.back().is_some_and(|t| t.elapsed() < window));
        let q = hits.entry(key).or_default();
        while q.front().is_some_and(|t| t.elapsed() >= window) {
            q.pop_front();
        }
        if q.len() >= per_min {
            return false;
        }
        q.push_back(Instant::now());
        true
    }

    /// The source a request came from: `X-Real-IP` when the peer is a trusted proxy (any
    /// peer, when `ELASTICPRO_TRUSTED_PROXIES` is unset — the same trust nginx's `X-Auth-User`
    /// gets), else the TCP peer.
    pub fn effective_source(&self, real_ip: Option<&str>, peer: Option<IpAddr>) -> Option<IpAddr> {
        let hdr = real_ip.and_then(|h| h.trim().parse::<IpAddr>().ok()).map(canon);
        match &self.server.trusted_proxies {
            Some(list) => match peer {
                Some(p) if source_allowed(list, p) => hdr.or(Some(canon(p))),
                p => p.map(canon),
            },
            None => hdr.or(peer.map(canon)),
        }
    }

    /// `allowedSources`, applied. Empty list = anyone (the signature still decides).
    pub fn source_ok(&self, source: Option<IpAddr>) -> bool {
        let list = self.resolved().allowed_sources;
        if list.is_empty() {
            return true;
        }
        source.is_some_and(|ip| source_allowed(&list, ip))
    }

    /* ------------------------------- the status ------------------------------- */

    /// Everything an admin may see. No secret, ever: presence flags only.
    pub fn status(&self, now: u64) -> Value {
        let f = self.file.read();
        let r = resolve(&self.server, &f);
        let managed = self.server.managed();
        let m: serde_json::Map<String, Value> = FIELDS.iter().map(|k| (k.to_string(), json!(managed.contains(k)))).collect();
        let pending = self.pending.lock();
        let pending = pending.as_ref().filter(|p| p.exp > now)
            .map(|p| json!({ "exp": p.exp, "zabbixUrl": p.zabbix_url, "by": p.by }));
        let token_source = if self.server.api_token.is_some() { "server" } else if f.api_token.is_some() { "ui" } else { "" };
        let secret_source = if self.server.sso_secret.is_some() { "server" } else if f.sso_secret.is_some() { "ui" } else { "" };
        json!({
            "zabbixUrl": r.zabbix_url,
            "apiUrl": r.api_url,
            "apiUrlIsDefault": self.server.api_url.is_none() && f.api_url.is_none() && r.zabbix_url.is_some(),
            "verifyTls": r.verify_tls,
            "allowHttp": f.allow_http,
            "allowedSources": r.allowed_sources,
            "syncSecs": r.sync_secs,
            "managed": m,
            "apiToken": {
                "set": r.api_token.is_some(), "source": token_source,
                "at": if token_source == "ui" { json!(f.token_set_at) } else { Value::Null },
                "by": if token_source == "ui" { json!(f.token_set_by) } else { Value::Null },
            },
            "ssoSecret": { "set": r.sso_secret.is_some(), "source": secret_source },
            "paired": f.paired_at.is_some() && f.sso_secret.is_some(),
            "pairedAt": f.paired_at, "pairedBy": f.paired_by, "zabbixVersion": f.zabbix_version,
            "pending": pending,
            "frameAncestors": r.frame_ancestors,
            "publicUrl": self.server.public_url,
            "events": f.events.iter().rev().take(10).cloned().collect::<Vec<_>>(),
        })
    }

    /* ------------------------------- changing it ------------------------------- */

    /// `ZABBIX_LINK_SET`. Absent keeps a field; `null` or `""` clears it (back to the
    /// default). A field the server owns is refused rather than silently ignored, and so
    /// is any key this does not know — `ssoSecret` above all, which only a pairing sets.
    /// Returns the names of the fields that changed and whether the API side did.
    pub fn set(&self, msg: &Value, by: &str, now: u64) -> Result<(Vec<String>, bool), String> {
        let obj = msg.as_object().ok_or("the message must be an object")?;
        const KNOWN: [&str; 9] = ["type", "session", "zabbixUrl", "apiUrl", "apiToken", "verifyTls", "allowedSources", "syncSecs", "allowHttp"];
        if let Some(k) = obj.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            let r = format!("{k} cannot be set here");
            self.event(by, "set", false, &r, None, now);
            let _ = self.save();
            return Err(r);
        }
        let managed = self.server.managed();
        if let Some(k) = FIELDS.iter().find(|k| obj.contains_key(**k) && managed.contains(k)) {
            let r = format!("{k} is managed by the server's configuration and cannot be changed here");
            self.event(by, "set", false, &r, None, now);
            let _ = self.save();
            return Err(r);
        }
        let mut next = self.file.read().clone();
        let result = (|| -> Result<(Vec<String>, bool), String> {
            let mut changed: Vec<String> = vec![];
            let mut api_changed = false;
            if let Some(v) = obj.get("allowHttp") {
                let b = v.as_bool().ok_or("allowHttp must be true or false")?;
                if b != next.allow_http {
                    next.allow_http = b;
                    changed.push("allowHttp".into());
                }
            }
            let str_or_clear = |k: &str| -> Result<Option<Option<String>>, String> {
                match obj.get(k) {
                    None => Ok(None),
                    Some(Value::Null) => Ok(Some(None)),
                    Some(Value::String(s)) if s.trim().is_empty() => Ok(Some(None)),
                    Some(Value::String(s)) => Ok(Some(Some(s.trim().to_string()))),
                    Some(_) => Err(format!("{k} must be a string")),
                }
            };
            if let Some(v) = str_or_clear("zabbixUrl")? {
                let v = v.map(|u| normalize_url(&u, next.allow_http).map_err(|e| format!("Zabbix URL: {e}"))).transpose()?;
                if v != next.zabbix_url {
                    next.zabbix_url = v;
                    changed.push("zabbixUrl".into());
                    api_changed = true;
                }
            }
            if let Some(v) = str_or_clear("apiUrl")? {
                let v = v.map(|u| normalize_url(&u, next.allow_http).map_err(|e| format!("API URL: {e}"))).transpose()?;
                if v != next.api_url {
                    next.api_url = v;
                    changed.push("apiUrl".into());
                    api_changed = true;
                }
            }
            if let Some(v) = str_or_clear("apiToken")? {
                if let Some(t) = &v {
                    if !valid_token(t) {
                        return Err("API token: expected 16–512 characters of letters, digits and - . _ ~ + / =".into());
                    }
                }
                if v != next.api_token {
                    next.token_set_at = v.as_ref().map(|_| now);
                    next.token_set_by = v.as_ref().map(|_| by.to_string());
                    next.api_token = v;
                    changed.push("apiToken".into());
                    api_changed = true;
                }
            }
            if let Some(v) = obj.get("verifyTls") {
                let b = match v {
                    Value::Null => None,
                    Value::Bool(b) => Some(*b),
                    _ => return Err("verifyTls must be true or false".into()),
                };
                if b != next.verify_tls {
                    next.verify_tls = b;
                    changed.push("verifyTls".into());
                    api_changed = true;
                }
            }
            if let Some(v) = obj.get("allowedSources") {
                let items: Vec<String> = match v {
                    Value::Null => vec![],
                    Value::String(s) => list(s),
                    Value::Array(a) => a.iter().map(|x| x.as_str().map(|s| s.trim().to_string()).ok_or("allowedSources must be strings"))
                        .collect::<Result<Vec<_>, _>>()?.into_iter().filter(|s| !s.is_empty()).collect(),
                    _ => return Err("allowedSources must be a list of IP addresses or CIDRs".into()),
                };
                if items.len() > MAX_SOURCES {
                    return Err(format!("allowedSources: at most {MAX_SOURCES} entries"));
                }
                for s in &items {
                    parse_source(s).map_err(|e| format!("allowedSources: {e}"))?;
                }
                if items != next.allowed_sources {
                    next.allowed_sources = items;
                    changed.push("allowedSources".into());
                }
            }
            if let Some(v) = obj.get("syncSecs") {
                let n = match v {
                    Value::Null => None,
                    v => Some(v.as_u64().filter(|n| (MIN_SYNC_SECS..=MAX_SYNC_SECS).contains(n))
                        .ok_or(format!("syncSecs must be a whole number from {MIN_SYNC_SECS} to {MAX_SYNC_SECS}"))?),
                };
                if n != next.sync_secs {
                    next.sync_secs = n;
                    changed.push("syncSecs".into());
                }
            }
            // Turning plain http off while an http address is stored would leave a setting
            // that could not be saved again. Refuse the combination instead.
            if !next.allow_http {
                for (k, u) in [("zabbixUrl", &next.zabbix_url), ("apiUrl", &next.api_url)] {
                    if u.as_deref().is_some_and(|u| u.starts_with("http:")) {
                        return Err(format!("{k} is plain http; keep \u{201c}allow plain http\u{201d} on or change it to https"));
                    }
                }
            }
            Ok((changed, api_changed))
        })();
        match result {
            Ok((changed, api)) => {
                if changed.is_empty() {
                    return Ok((changed, false));
                }
                *self.file.write() = next;
                self.event(by, "set", true, &format!("changed {}", changed.join(", ")), None, now);
                self.save()?;
                Ok((changed, api))
            }
            Err(e) => {
                self.event(by, "set", false, &e, None, now);
                let _ = self.save();
                Err(e)
            }
        }
    }

    /// `ZABBIX_PAIR_BEGIN`. Returns the pairing code and when it expires.
    ///
    /// Refused when the SSO secret is the server's: pairing would hand the module a new
    /// secret the server's setting then overrides, and sign-in would stop working.
    pub fn begin_pair(&self, zabbix_url: Option<&str>, ep_url: Option<&str>, by: &str, now: u64) -> Result<(String, u64, String, String), String> {
        let res = (|| {
            if self.server.sso_secret.is_some() {
                return Err("the sign-in secret is set in the server's configuration (ELASTICPRO_ZABBIX_SSO_SECRET / _FILE); \
                            pairing from here would be overridden by it. Remove that setting to pair from the UI, \
                            or keep configuring the module's config.php by hand".to_string());
            }
            let allow_http = self.file.read().allow_http;
            let zurl = match &self.server.zabbix_url {
                Some(u) => u.clone(),
                None => normalize_url(zabbix_url.unwrap_or(""), allow_http).map_err(|e| format!("Zabbix URL: {e}"))?,
            };
            let ep = match &self.server.public_url {
                Some(u) => u.clone(),
                None => normalize_url(ep_url.unwrap_or(""), allow_http).map_err(|e| format!("ElasticPro address: {e}"))?,
            };
            let secret = random_secret();
            debug_assert!(secret.len() >= MIN_SECRET_LEN);
            let nonce = crate::auth::random_hex(16);
            let exp = now + PAIR_TTL_SECS;
            let code = pairing_code(&ep, &secret, &nonce, exp);
            // A new pairing replaces one that did not finish; the working secret is not
            // touched until a pairing does.
            *self.pending.lock() = Some(Pending { secret, nonce, zabbix_url: zurl.clone(), exp, by: by.to_string() });
            Ok((code, exp, zurl, ep))
        })();
        match &res {
            Ok((_, exp, z, e)) => self.event(by, "pair_begin", true, &format!("for {z}, callback {e}, expires {exp}"), None, now),
            Err(e) => self.event(by, "pair_begin", false, e, None, now),
        }
        let _ = self.save();
        res
    }

    /// `POST /zabbix/pair`. Checks, in this order: the source, that a pairing is in progress,
    /// the signature (before the body is parsed at all), the clock, replay, the nonce, the
    /// expiry, the origin, then the fields. Stores the result only when every check passed.
    pub fn complete_pair(&self, body: &[u8], signature: &str, source: Option<IpAddr>, now: u64) -> Result<Paired, PairError> {
        let src = source.map(|s| s.to_string());
        let res = self.check_pair(body, signature, source, now);
        match &res {
            Ok(p) => {
                self.event("zabbix-module", "pair", true,
                           &format!("paired with {} (Zabbix {}), API {}", p.zabbix_url, if p.zabbix_version.is_empty() { "?" } else { &p.zabbix_version }, p.api_url),
                           src, now);
            }
            Err(e) => {
                tracing::warn!(target: "audit", reason = %e.audit_reason(), source = src.as_deref().unwrap_or("-"), "zabbix pairing refused");
                self.event("zabbix-module", "pair", false, &e.audit_reason(), src, now);
            }
        }
        let _ = self.save();
        res
    }

    fn check_pair(&self, body: &[u8], signature: &str, source: Option<IpAddr>, now: u64) -> Result<Paired, PairError> {
        if !self.source_ok(source) {
            return Err(PairError::Forbidden(source.map(|s| s.to_string()).unwrap_or_else(|| "unknown".into())));
        }
        if !self.rate_ok("pair", source, PAIR_PER_MIN) {
            return Err(PairError::RateLimited);
        }
        let mut pending = self.pending.lock();
        let Some(p) = pending.as_ref() else { return Err(PairError::Unauthorized("no pairing in progress")) };
        if !ZabbixSso::signature_ok(p.secret.as_bytes(), body, signature) {
            return Err(PairError::Unauthorized("bad signature"));
        }
        let refused = |kind: &'static str, why: &str| PairError::Refused { kind, why: why.to_string() };
        let b: PairBody = serde_json::from_slice(body).map_err(|e| refused("bad_request", &format!("the body is not a pairing request: {e}")))?;
        if now.abs_diff(b.ts) > MAX_SKEW_SECS {
            return Err(refused("stale", "ts is more than 60 s from ElasticPro's clock — check both hosts' clocks"));
        }
        {
            let mut seen = self.seen.lock();
            let keep = Duration::from_secs(MAX_SKEW_SECS * 2 + 5);
            seen.retain(|_, t| t.elapsed() < keep);
            let key = signature.trim().to_ascii_lowercase();
            if seen.contains_key(&key) {
                return Err(refused("replayed", "that pairing request was already used"));
            }
            seen.insert(key, Instant::now());
        }
        if !crate::auth::ct_eq(b.nonce.as_bytes(), p.nonce.as_bytes()) {
            return Err(refused("nonce_mismatch", "the nonce is not the one in the current pairing code — paste the newest code"));
        }
        if now >= p.exp {
            *pending = None;
            return Err(refused("expired", "the pairing code has expired — press Pair with Zabbix again in ElasticPro"));
        }
        if !same_origin(&b.zabbix_url, &p.zabbix_url) {
            return Err(refused("origin_mismatch", &format!(
                "zabbixUrl {} is not the Zabbix address the pairing was started for ({})", b.zabbix_url, p.zabbix_url)));
        }
        let allow_http = p.zabbix_url.starts_with("http:") || self.file.read().allow_http;
        let api_url = normalize_url(&b.api_url, allow_http).map_err(|e| refused("bad_request", &format!("apiUrl: {e}")))?;
        if !valid_token(b.api_token.trim()) {
            return Err(refused("bad_request", "apiToken is missing or malformed"));
        }
        let version: String = b.zabbix_version.chars().filter(|c| !c.is_control()).take(64).collect();
        // Every check passed: the nonce is spent and the new secret becomes the one.
        let p = pending.take().expect("checked above");
        drop(pending);
        {
            let mut f = self.file.write();
            f.sso_secret = Some(p.secret.clone());
            f.zabbix_url = Some(p.zabbix_url.clone());
            f.api_url = Some(api_url.clone());
            f.api_token = Some(b.api_token.trim().to_string());
            f.token_set_at = Some(now);
            f.token_set_by = Some(format!("pairing (started by {})", p.by));
            f.paired_at = Some(now);
            f.paired_by = Some(p.by.clone());
            f.zabbix_version = Some(version.clone()).filter(|v| !v.is_empty());
        }
        Ok(Paired { secret: p.secret, zabbix_url: p.zabbix_url, api_url, zabbix_version: version, by: p.by })
    }

    /// `ZABBIX_UNPAIR`: the secret and the token go, and any pairing in progress with them.
    pub fn unpair(&self, by: &str, now: u64) -> Result<(), String> {
        *self.pending.lock() = None;
        {
            let mut f = self.file.write();
            f.sso_secret = None;
            f.api_token = None;
            f.token_set_at = None;
            f.token_set_by = None;
            f.paired_at = None;
            f.paired_by = None;
            f.zabbix_version = None;
        }
        let managed: Vec<&str> = self.server.managed().into_iter().filter(|f| *f == "apiToken" || *f == "ssoSecret").collect();
        let detail = if managed.is_empty() {
            "removed the API token and the sign-in secret".to_string()
        } else {
            format!("removed the stored API token and sign-in secret; {} still set by the server's configuration", managed.join(" and "))
        };
        self.event(by, "unpair", true, &detail, None, now);
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_checked() {
        assert_eq!(normalize_url("https://zbx.example.com/", false).unwrap(), "https://zbx.example.com");
        assert_eq!(normalize_url(" https://zbx.example.com/zabbix/ ", false).unwrap(), "https://zbx.example.com/zabbix");
        assert!(normalize_url("http://zbx", false).is_err());
        assert_eq!(normalize_url("http://zbx:8080", true).unwrap(), "http://zbx:8080");
        assert!(normalize_url("ftp://zbx", true).is_err());
        assert!(normalize_url("https://u:p@zbx", false).is_err());
        assert!(normalize_url("https://zbx/?a=1", false).is_err());
        assert!(normalize_url("zbx.example.com", false).is_err());
        for bad in ["http://u:hunter2secret@zbx", "ftp://u:hunter2secret@zbx", "https://u:hunter2secret@zbx", "hunter2secret"] {
            assert!(!normalize_url(bad, false).unwrap_err().contains("hunter2secret"), "{bad} was echoed back");
        }
    }

    #[test]
    fn origins_compare_scheme_host_and_port() {
        assert!(same_origin("https://ZBX.example.com/zabbix", "https://zbx.example.com:443/"));
        assert!(!same_origin("https://zbx.example.com", "http://zbx.example.com"));
        assert!(!same_origin("https://zbx.example.com", "https://zbx.example.com:8443"));
        assert!(!same_origin("https://zbx.example.com.evil.io", "https://zbx.example.com"));
        assert_eq!(origin("https://h:9443/x").as_deref(), Some("https://h:9443"));
    }

    #[test]
    fn sources_and_cidrs() {
        let l = vec!["10.0.0.0/24".to_string(), "203.0.113.10".to_string(), "fd00::/8".to_string()];
        assert!(source_allowed(&l, "10.0.0.77".parse().unwrap()));
        assert!(!source_allowed(&l, "10.0.1.1".parse().unwrap()));
        assert!(source_allowed(&l, "203.0.113.10".parse().unwrap()));
        assert!(source_allowed(&l, "::ffff:203.0.113.10".parse().unwrap()), "v4-mapped v6 is the v4 address");
        assert!(source_allowed(&l, "fd12::1".parse().unwrap()));
        assert!(parse_source("10.0.0.0/33").is_err());
        assert!(parse_source("nonsense").is_err());
        assert!(source_allowed(&["0.0.0.0/0".to_string()], "8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn tokens() {
        assert!(valid_token(&"a".repeat(64)));
        assert!(!valid_token("short"));
        assert!(!valid_token(&format!("{}\n", "a".repeat(40))));
        assert!(!valid_token(&format!("{} x", "a".repeat(40))));
    }

    #[test]
    fn a_pairing_code_round_trips() {
        let c = pairing_code("https://ep", "s".repeat(43).as_str(), "n1", 99);
        assert!(!c.contains('='), "unpadded");
        let v = decode_pairing_code(&c).unwrap();
        assert_eq!(v, json!({ "v": 1, "ep": "https://ep", "secret": "s".repeat(43), "nonce": "n1", "exp": 99 }));
        assert_eq!(decode_pairing_code(&format!("{c}==")).unwrap(), v, "padding is tolerated");
    }

    #[test]
    fn secrets_are_long_enough_for_the_sign_in() {
        assert!(random_secret().len() >= MIN_SECRET_LEN);
        assert_ne!(random_secret(), random_secret());
    }

    #[test]
    fn the_server_wins_field_by_field() {
        let file = LinkFile {
            zabbix_url: Some("https://ui-zbx".into()), api_url: None, api_token: Some("ui-token".into()),
            sso_secret: Some("ui-secret".into()), verify_tls: Some(false), sync_secs: Some(600), ..Default::default()
        };
        let r = resolve(&ServerZbx::default(), &file);
        assert_eq!(r.api_url.as_deref(), Some("https://ui-zbx/api_jsonrpc.php"), "the API address defaults from the frontend's");
        assert_eq!((r.verify_tls, r.sync_secs), (false, 600));
        assert_eq!(r.frame_ancestors, "https://ui-zbx");
        let server = ServerZbx { api_token: Some("env-token".into()), sso_secret: Some("env-secret".into()),
                                 api_url: Some("http://zabbix-web:8080/api_jsonrpc.php".into()), ..Default::default() };
        let r = resolve(&server, &file);
        assert_eq!(r.api_token.as_deref(), Some("env-token"));
        assert_eq!(r.sso_secret.as_deref(), Some("env-secret"));
        assert_eq!(r.api_url.as_deref(), Some("http://zabbix-web:8080/api_jsonrpc.php"));
        assert_eq!(r.zabbix_url.as_deref(), Some("https://ui-zbx"), "what the server does not set still comes from the UI");
        assert_eq!(server.managed(), vec!["apiUrl", "apiToken", "ssoSecret"]);
        let fa = ServerZbx { frame_ancestors: Some("https://a https://b;script-src *".into()), ..Default::default() };
        assert_eq!(resolve(&fa, &file).frame_ancestors, "https://a https://b");
        assert_eq!(resolve(&ServerZbx::default(), &LinkFile::default()).frame_ancestors, "'none'");
    }
}
