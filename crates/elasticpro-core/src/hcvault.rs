//! HashiCorp Vault (or OpenBao — same API), for the Elasticsearch passwords a Zabbix host
//! names in a Vault macro.
//!
//! Zabbix will never hand back a Secret macro's value through its API. A Vault macro is
//! different: its value is a path, `secret/elasticpro/vm-1:password`, and whoever holds a
//! token with read on that path can fetch the secret. Zabbix's server does, for its own
//! checks; this does, for ElasticPro's. The password lives in exactly one place.
//!
//! Signing in is AppRole: a role id and a secret id, each read from a file, traded for a
//! short-lived token that is cached and replaced before it expires. Read-only, and only
//! under whatever the Vault policy allows — `setup.sh` grants `secret/data/elasticpro/*`.
//!
//! Paths are written the way Zabbix writes them. For KV version 2, Zabbix inserts `data`
//! after the mount (`secret/elasticpro/vm-1` is read at `v1/secret/data/elasticpro/vm-1`);
//! this does the same, so a macro means one thing to both readers.

use parking_lot::Mutex;
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct SecretRef {
    pub mount: String,
    pub path: String,
    pub key: String,
}

/// `secret/elasticpro/vm-1:password` → mount `secret`, path `elasticpro/vm-1`, key
/// `password`. Refuses anything it would have to guess at: no key, no path under the mount,
/// or a `..` that could walk out of the path the policy was written for.
pub fn parse_ref(s: &str) -> Result<SecretRef, String> {
    let s = s.trim();
    let (loc, key) = s.rsplit_once(':').ok_or_else(|| format!("{s:?} has no \":key\" — write it as mount/path:key"))?;
    let loc = loc.trim_matches('/');
    let (mount, path) = loc.split_once('/').ok_or_else(|| format!("{s:?} names a mount but no path under it"))?;
    if key.is_empty() || mount.is_empty() || path.is_empty() {
        return Err(format!("{s:?} is incomplete — write it as mount/path:key"));
    }
    if loc.split('/').any(|seg| seg == ".." || seg == "." || seg.is_empty()) {
        return Err(format!("{s:?} has an empty, . or .. segment"));
    }
    Ok(SecretRef { mount: mount.to_string(), path: path.to_string(), key: key.to_string() })
}

/// The KV v2 read URL for a reference.
pub fn read_url(addr: &str, r: &SecretRef) -> String {
    format!("{}/v1/{}/data/{}", addr.trim_end_matches('/'), r.mount, r.path)
}

#[derive(Debug)]
pub enum VaultError {
    NotConfigured,
    Unreachable(String),
    Denied(String),
    Missing(String),
    Bad(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::NotConfigured => write!(f, "Vault is not configured on this server (ELASTICPRO_VAULT_ADDR and an AppRole)"),
            VaultError::Unreachable(e) => write!(f, "Vault did not answer: {e}"),
            VaultError::Denied(e) => write!(f, "Vault refused: {e}"),
            VaultError::Missing(e) => write!(f, "{e}"),
            VaultError::Bad(e) => write!(f, "{e}"),
        }
    }
}

pub struct Vault {
    addr: Option<String>,
    role_id: String,
    secret_id: String,
    token: Mutex<Option<(String, Instant)>>,
    http: reqwest::Client,
}

impl Vault {
    /// `ELASTICPRO_VAULT_ADDR`, `ELASTICPRO_VAULT_ROLE_ID_FILE`, `ELASTICPRO_VAULT_SECRET_ID_FILE`.
    pub fn from_env() -> Vault {
        Vault::from_env_with("ELASTICPRO_VAULT_ROLE_ID_FILE", "ELASTICPRO_VAULT_SECRET_ID_FILE")
    }

    /// The writing AppRole (`ELASTICPRO_VAULT_WRITE_ROLE_ID_FILE`, `…_SECRET_ID_FILE`), used only
    /// to store the password of a cluster ElasticPro creates a Zabbix host for.
    pub fn writer_from_env() -> Vault {
        Vault::from_env_with("ELASTICPRO_VAULT_WRITE_ROLE_ID_FILE", "ELASTICPRO_VAULT_WRITE_SECRET_ID_FILE")
    }

    fn from_env_with(role_var: &str, secret_var: &str) -> Vault {
        let read = |var: &str| {
            std::env::var(var).ok().and_then(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string()).unwrap_or_default()
        };
        Vault::new(std::env::var("ELASTICPRO_VAULT_ADDR").ok().filter(|s| !s.trim().is_empty()), read(role_var), read(secret_var))
    }

    pub fn new(addr: Option<String>, role_id: String, secret_id: String) -> Vault {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().expect("reqwest client");
        Vault { addr, role_id, secret_id, token: Mutex::new(None), http }
    }

    pub fn configured(&self) -> bool {
        self.addr.is_some() && !self.role_id.is_empty() && !self.secret_id.is_empty()
    }

    pub fn addr(&self) -> Option<&str> {
        self.addr.as_deref()
    }

    async fn token(&self) -> Result<String, VaultError> {
        if let Some((t, until)) = self.token.lock().clone() {
            if Instant::now() < until {
                return Ok(t);
            }
        }
        let addr = self.addr.as_deref().ok_or(VaultError::NotConfigured)?;
        let res = self.http.post(format!("{}/v1/auth/approle/login", addr.trim_end_matches('/')))
            .json(&serde_json::json!({ "role_id": self.role_id, "secret_id": self.secret_id }))
            .send().await.map_err(|e| VaultError::Unreachable(e.to_string()))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(VaultError::Denied(format!("AppRole login answered {status}: {}", errors(&body))));
        }
        let tok = body["auth"]["client_token"].as_str().ok_or_else(|| VaultError::Bad("AppRole login returned no token".into()))?;
        let ttl = body["auth"]["lease_duration"].as_u64().unwrap_or(300);
        // Replaced a little early, so a read never races the expiry.
        let until = Instant::now() + Duration::from_secs(ttl.saturating_sub(ttl / 10 + 5).max(10));
        *self.token.lock() = Some((tok.to_string(), until));
        Ok(tok.to_string())
    }

    /// Store fields at `mount/path` (KV v2), replacing what was there.
    pub async fn write(&self, mount_path: &str, data: Value) -> Result<(), VaultError> {
        let r = parse_ref(&format!("{}:x", mount_path.trim_matches('/'))).map_err(VaultError::Bad)?;
        let addr = self.addr.as_deref().ok_or(VaultError::NotConfigured)?;
        for attempt in 0..2 {
            let tok = self.token().await?;
            let res = self.http.post(read_url(addr, &r)).header("X-Vault-Token", tok)
                .json(&serde_json::json!({ "data": data })).send().await.map_err(|e| VaultError::Unreachable(e.to_string()))?;
            let status = res.status();
            if status.as_u16() == 403 && attempt == 0 {
                *self.token.lock() = None;
                continue;
            }
            if !status.is_success() {
                let body: Value = res.json().await.unwrap_or(Value::Null);
                return Err(VaultError::Denied(format!("writing {}/{} answered {status}: {}", r.mount, r.path, errors(&body))));
            }
            return Ok(());
        }
        Err(VaultError::Denied("the token was refused twice".into()))
    }

    /// The value a reference names.
    pub async fn read(&self, reference: &str) -> Result<String, VaultError> {
        let r = parse_ref(reference).map_err(VaultError::Bad)?;
        let addr = self.addr.as_deref().ok_or(VaultError::NotConfigured)?;
        for attempt in 0..2 {
            let tok = self.token().await?;
            let res = self.http.get(read_url(addr, &r)).header("X-Vault-Token", tok)
                .send().await.map_err(|e| VaultError::Unreachable(e.to_string()))?;
            let status = res.status();
            let body: Value = res.json().await.unwrap_or(Value::Null);
            // A token revoked or expired early: sign in again, once.
            if status.as_u16() == 403 && attempt == 0 {
                *self.token.lock() = None;
                continue;
            }
            if status.as_u16() == 404 {
                return Err(VaultError::Missing(format!("nothing is stored at {}/{} in Vault", r.mount, r.path)));
            }
            if !status.is_success() {
                return Err(VaultError::Denied(format!("reading {}/{} answered {status}: {}", r.mount, r.path, errors(&body))));
            }
            return body["data"]["data"][&r.key].as_str().map(String::from).ok_or_else(|| {
                VaultError::Missing(format!("{}/{} in Vault has no {:?} field", r.mount, r.path, r.key))
            });
        }
        Err(VaultError::Denied("the token was refused twice".into()))
    }
}

fn errors(body: &Value) -> String {
    body["errors"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; "))
        .filter(|s| !s.is_empty()).unwrap_or_else(|| "no detail".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zabbix_style_reference_is_parsed() {
        let r = parse_ref("secret/elasticpro/vm-1:password").unwrap();
        assert_eq!(r, SecretRef { mount: "secret".into(), path: "elasticpro/vm-1".into(), key: "password".into() });
        assert_eq!(read_url("http://vault:8200/", &r), "http://vault:8200/v1/secret/data/elasticpro/vm-1");
    }

    #[test]
    fn incomplete_or_escaping_references_are_refused() {
        for bad in ["secret/elasticpro/vm-1", "secret:password", ":password", "secret/../sys/x:k",
                    "secret//x:k", "secret/x:", ""] {
            assert!(parse_ref(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn unconfigured_is_said_plainly() {
        let v = Vault::new(None, String::new(), String::new());
        assert!(!v.configured());
    }
}
