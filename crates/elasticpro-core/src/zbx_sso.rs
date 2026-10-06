//! Signing in from Zabbix.
//!
//! The ElasticPro module inside Zabbix knows who is looking at the page — Zabbix has
//! already authenticated them — and needs this app to agree without asking for a second
//! password. It does that server to server:
//!
//! 1. Zabbix's PHP posts `{username, zabbix_user_type, groups, ts, nonce}` to
//!    `/sso/zabbix`, with an HMAC-SHA256 of the exact body under a secret both sides hold.
//! 2. This checks the signature, the clock and the nonce, creates or refreshes the account
//!    `<username>@zabbix`, and hands back a code that works once, for sixty seconds.
//! 3. The page Zabbix renders loads this app with that code; the app trades it for an
//!    ordinary session (`SSO_EXCHANGE`) and removes it from the address bar.
//!
//! What stops this being a way in for anybody else:
//!
//! * The secret. Without it no body verifies. It is read from the environment, never
//!   from the config the UI edits, and a short one disables the feature rather than
//!   weakening it.
//! * The route is meant for the internal network only. nginx refuses `/sso/` from
//!   outside; Zabbix reaches the core directly on the Docker network. Both are required
//!   — the network rule is not a substitute for the signature, nor the other way round.
//! * Replay. A signed body is good for sixty seconds and exactly once.
//! * The code, not a session, is what goes near a browser, and it is spent on first use.
//!
//! The mapping, which is the product decision this implements:
//!
//! | Zabbix user type | Here      | Clusters                                   |
//! |------------------|-----------|--------------------------------------------|
//! | 1 User           | user      | only those tagged with one of their groups |
//! | 2 Admin          | operator  | all                                        |
//! | 3 Super admin    | admin     | all                                        |

use crate::auth::{ct_eq, random_hex, Role};
use hmac::{Hmac, Mac};
use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use sha2::Sha256;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How far the Zabbix server's clock may be from ours, either way.
pub const MAX_SKEW_SECS: u64 = 60;
/// How long a code survives between Zabbix minting it and the browser spending it.
pub const CODE_TTL: Duration = Duration::from_secs(60);
/// Shorter than this and the secret is refused, which leaves the feature off.
pub const MIN_SECRET_LEN: usize = 32;
/// What every account made this way is called: `alice@zabbix`. Namespaced so a Zabbix
/// user named `admin` is never the local `admin`.
pub const SUFFIX: &str = "@zabbix";
pub const SOURCE: &str = "zabbix";

/// What Zabbix vouches for.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Claim {
    pub username: String,
    pub zabbix_user_type: i64,
    #[serde(default)]
    pub groups: Vec<String>,
    pub ts: u64,
    pub nonce: String,
}

#[derive(Debug, PartialEq)]
pub enum SsoError {
    NotConfigured,
    BadSignature,
    BadBody(String),
    Stale,
    Replayed,
    NoRole(i64),
}

impl std::fmt::Display for SsoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SsoError::NotConfigured => write!(f, "Zabbix sign-in is not configured: set ELASTICPRO_ZABBIX_SSO_SECRET (at least {MIN_SECRET_LEN} characters) on the core"),
            SsoError::BadSignature => write!(f, "the signature does not match — the module_secret in the Zabbix module and ELASTICPRO_ZABBIX_SSO_SECRET here differ"),
            SsoError::BadBody(why) => write!(f, "the sign-in request is malformed: {why}"),
            SsoError::Stale => write!(f, "the sign-in request is too old or from the future — check the clocks on the Zabbix and ElasticPro hosts"),
            SsoError::Replayed => write!(f, "that sign-in request was already used"),
            SsoError::NoRole(t) => write!(f, "Zabbix user type {t} has no ElasticPro role (guests are not signed in)"),
        }
    }
}

/// The role a Zabbix user type becomes. Guest (4) and anything unknown get nothing.
pub fn role_for(zabbix_user_type: i64) -> Option<Role> {
    match zabbix_user_type {
        1 => Some(Role::User),
        2 => Some(Role::Operator),
        3 => Some(Role::Admin),
        _ => None,
    }
}

/// Only a Zabbix User is limited to clusters. Admins and super admins see the fleet.
pub fn scope_for(role: Role, groups: &[String]) -> Option<Vec<String>> {
    if role == Role::User {
        let mut g: Vec<String> = groups.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        g.sort();
        g.dedup();
        Some(g)
    } else {
        None
    }
}

pub fn account_name(username: &str) -> String {
    format!("{}{SUFFIX}", username.trim())
}

pub struct ZabbixSso {
    secret: RwLock<Option<Vec<u8>>>,
    nonces: Mutex<HashMap<String, Instant>>,
    codes: Mutex<HashMap<String, (String, Instant)>>,
    code_ttl: Duration,
}

impl Default for ZabbixSso {
    fn default() -> Self {
        ZabbixSso {
            secret: RwLock::new(None),
            nonces: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
            code_ttl: CODE_TTL,
        }
    }
}

impl ZabbixSso {
    /// `ELASTICPRO_ZABBIX_SSO_SECRET`, or the contents of `ELASTICPRO_ZABBIX_SSO_SECRET_FILE`.
    pub fn from_env() -> ZabbixSso {
        let s = ZabbixSso::default();
        let secret = std::env::var("ELASTICPRO_ZABBIX_SSO_SECRET").ok().filter(|v| !v.trim().is_empty()).or_else(|| {
            std::env::var("ELASTICPRO_ZABBIX_SSO_SECRET_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok())
        });
        if let Some(sec) = secret {
            if let Err(why) = s.set_secret(&sec) {
                tracing::warn!("Zabbix sign-in left off: {why}");
            }
        }
        s
    }

    pub fn set_secret(&self, secret: &str) -> Result<(), String> {
        let t = secret.trim();
        if t.len() < MIN_SECRET_LEN {
            return Err(format!("the secret is {} characters; at least {MIN_SECRET_LEN} are required", t.len()));
        }
        *self.secret.write() = Some(t.as_bytes().to_vec());
        Ok(())
    }

    pub fn configured(&self) -> bool {
        self.secret.read().is_some()
    }

    /// Turn sign-in off: nothing verifies until a secret is set again. Unpairing uses it.
    pub fn clear_secret(&self) {
        *self.secret.write() = None;
    }

    #[doc(hidden)]
    pub fn with_code_ttl(mut self, ttl: Duration) -> Self {
        self.code_ttl = ttl;
        self
    }

    /// Hex HMAC-SHA256 of `body` under the secret. Public so the tests — and the Zabbix
    /// module's own test — sign exactly the way this verifies.
    pub fn sign(secret: &[u8], body: &[u8]) -> String {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("hmac takes any key length");
        m.update(body);
        hex::encode(m.finalize().into_bytes())
    }

    /// Whether `signature_hex` is the HMAC of exactly these bytes under `secret`, compared
    /// in constant time. The one check every signed request from the Zabbix module goes
    /// through — the sign-in here, and the pairing in `zbx_link` — so there is one
    /// implementation of the scheme, not two that could drift.
    pub fn signature_ok(secret: &[u8], body: &[u8], signature_hex: &str) -> bool {
        let want = ZabbixSso::sign(secret, body);
        let got = signature_hex.trim().to_ascii_lowercase();
        ct_eq(want.as_bytes(), got.as_bytes())
    }

    /// Check a signed body and return what it claims. `now_secs` is a parameter so the
    /// clock can be tested; the caller passes the real one.
    pub fn verify(&self, body: &[u8], signature_hex: &str, now_secs: u64) -> Result<Claim, SsoError> {
        let secret = self.secret.read().clone().ok_or(SsoError::NotConfigured)?;
        // Signature before anything else is read: an unsigned body is not parsed at all.
        if !ZabbixSso::signature_ok(&secret, body, signature_hex) {
            return Err(SsoError::BadSignature);
        }
        let c: Claim = serde_json::from_slice(body).map_err(|e| SsoError::BadBody(e.to_string()))?;
        let name = c.username.trim();
        if name.is_empty() || name.len() > 128 || name.chars().any(|ch| ch.is_control()) {
            return Err(SsoError::BadBody("username is empty, too long or has control characters".into()));
        }
        if c.nonce.len() < 16 || c.nonce.len() > 128 {
            return Err(SsoError::BadBody("nonce must be 16–128 characters".into()));
        }
        if c.groups.len() > 500 || c.groups.iter().any(|g| g.len() > 255) {
            return Err(SsoError::BadBody("too many groups, or a group name over 255 characters".into()));
        }
        if now_secs.abs_diff(c.ts) > MAX_SKEW_SECS {
            return Err(SsoError::Stale);
        }
        {
            let mut seen = self.nonces.lock();
            // Anything older than twice the skew can no longer pass the clock check, so it
            // no longer needs remembering.
            let keep = Duration::from_secs(MAX_SKEW_SECS * 2 + 5);
            seen.retain(|_, t| t.elapsed() < keep);
            if seen.contains_key(&c.nonce) {
                return Err(SsoError::Replayed);
            }
            seen.insert(c.nonce.clone(), Instant::now());
        }
        if role_for(c.zabbix_user_type).is_none() {
            return Err(SsoError::NoRole(c.zabbix_user_type));
        }
        Ok(c)
    }

    /// A one-time code for this account.
    pub fn issue_code(&self, account: &str) -> String {
        let code = random_hex(32);
        let mut codes = self.codes.lock();
        let ttl = self.code_ttl;
        codes.retain(|_, (_, t)| t.elapsed() < ttl);
        codes.insert(code.clone(), (account.to_string(), Instant::now()));
        code
    }

    /// The account a code was issued for — once. Spent whether or not it had expired.
    pub fn redeem(&self, code: &str) -> Option<String> {
        let (account, at) = self.codes.lock().remove(code.trim())?;
        (at.elapsed() < self.code_ttl).then_some(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-test";

    fn sso() -> ZabbixSso {
        let s = ZabbixSso::default();
        s.set_secret(SECRET).unwrap();
        s
    }

    fn body(user: &str, ty: i64, groups: &[&str], ts: u64, nonce: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "username": user, "zabbix_user_type": ty, "groups": groups, "ts": ts, "nonce": nonce,
        }))
        .unwrap()
    }

    fn signed(b: &[u8]) -> String {
        ZabbixSso::sign(SECRET.as_bytes(), b)
    }

    const NOW: u64 = 1_790_000_000;

    #[test]
    fn a_correctly_signed_request_is_accepted() {
        let b = body("alice", 1, &["ES vm-1"], NOW, "nonce-0000000001");
        let c = sso().verify(&b, &signed(&b), NOW).unwrap();
        assert_eq!(c.username, "alice");
        assert_eq!(c.groups, vec!["ES vm-1".to_string()]);
    }

    #[test]
    fn the_signature_is_over_the_exact_bytes() {
        // Re-serialising would change nothing semantically and everything cryptographically:
        // the MAC covers what was sent, so one changed byte is a different request.
        let b = body("alice", 1, &[], NOW, "nonce-0000000002");
        let sig = signed(&b);
        let tampered = body("alice", 3, &[], NOW, "nonce-0000000002");
        assert_eq!(sso().verify(&tampered, &sig, NOW), Err(SsoError::BadSignature));
    }

    #[test]
    fn a_different_secret_is_refused() {
        let b = body("alice", 1, &[], NOW, "nonce-0000000003");
        let wrong = ZabbixSso::sign(b"another-secret-that-is-long-enough-000", &b);
        assert_eq!(sso().verify(&b, &wrong, NOW), Err(SsoError::BadSignature));
    }

    #[test]
    fn an_unconfigured_core_refuses_everything() {
        let b = body("alice", 3, &[], NOW, "nonce-0000000004");
        assert_eq!(ZabbixSso::default().verify(&b, &signed(&b), NOW), Err(SsoError::NotConfigured));
    }

    #[test]
    fn a_short_secret_leaves_the_feature_off() {
        let s = ZabbixSso::default();
        assert!(s.set_secret("short").is_err());
        assert!(!s.configured());
    }

    #[test]
    fn old_and_future_requests_are_refused() {
        let s = sso();
        let old = body("a", 1, &[], NOW - MAX_SKEW_SECS - 1, "nonce-0000000005");
        assert_eq!(s.verify(&old, &signed(&old), NOW), Err(SsoError::Stale));
        let fut = body("a", 1, &[], NOW + MAX_SKEW_SECS + 1, "nonce-0000000006");
        assert_eq!(s.verify(&fut, &signed(&fut), NOW), Err(SsoError::Stale));
        let edge = body("a", 1, &[], NOW - MAX_SKEW_SECS, "nonce-0000000007");
        assert!(s.verify(&edge, &signed(&edge), NOW).is_ok(), "the boundary itself is inside the window");
    }

    #[test]
    fn a_request_works_once() {
        let s = sso();
        let b = body("alice", 1, &[], NOW, "nonce-0000000008");
        let sig = signed(&b);
        assert!(s.verify(&b, &sig, NOW).is_ok());
        assert_eq!(s.verify(&b, &sig, NOW), Err(SsoError::Replayed));
    }

    #[test]
    fn a_guest_is_not_signed_in() {
        let s = sso();
        let b = body("guest", 4, &[], NOW, "nonce-0000000009");
        assert_eq!(s.verify(&b, &signed(&b), NOW), Err(SsoError::NoRole(4)));
    }

    #[test]
    fn malformed_bodies_are_refused_after_the_signature() {
        let s = sso();
        let b = body("", 1, &[], NOW, "nonce-0000000010");
        assert!(matches!(s.verify(&b, &signed(&b), NOW), Err(SsoError::BadBody(_))));
        let b = body("x", 1, &[], NOW, "short");
        assert!(matches!(s.verify(&b, &signed(&b), NOW), Err(SsoError::BadBody(_))));
        let b = body("x\u{0007}", 1, &[], NOW, "nonce-0000000011");
        assert!(matches!(s.verify(&b, &signed(&b), NOW), Err(SsoError::BadBody(_))));
    }

    #[test]
    fn roles_map_as_agreed() {
        assert_eq!(role_for(1), Some(Role::User));
        assert_eq!(role_for(2), Some(Role::Operator));
        assert_eq!(role_for(3), Some(Role::Admin));
        assert_eq!(role_for(4), None);
        assert_eq!(role_for(0), None);
    }

    #[test]
    fn only_a_zabbix_user_is_scoped() {
        let g = vec![" ES vm-1 ".to_string(), "".to_string(), "ES vm-1".to_string()];
        assert_eq!(scope_for(Role::User, &g), Some(vec!["ES vm-1".to_string()]));
        assert_eq!(scope_for(Role::Operator, &g), None);
        assert_eq!(scope_for(Role::Admin, &g), None);
        // In no group at all is still scoped — to nothing.
        assert_eq!(scope_for(Role::User, &[]), Some(vec![]));
    }

    #[test]
    fn names_are_namespaced() {
        assert_eq!(account_name(" Admin "), "Admin@zabbix");
    }

    #[test]
    fn a_code_is_spent_on_first_use() {
        let s = sso();
        let code = s.issue_code("alice@zabbix");
        assert_eq!(s.redeem(&code).as_deref(), Some("alice@zabbix"));
        assert_eq!(s.redeem(&code), None);
        assert_eq!(s.redeem("not-a-code"), None);
    }

    #[test]
    fn an_expired_code_is_worthless() {
        let s = sso().with_code_ttl(Duration::from_millis(0));
        let code = s.issue_code("alice@zabbix");
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(s.redeem(&code), None);
    }
}
