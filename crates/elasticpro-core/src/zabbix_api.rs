//! Clusters that come from Zabbix hosts.
//!
//! A Zabbix host carrying the cluster template (`Elasticsearch Cluster by HTTP EP` by
//! default) is an Elasticsearch cluster. An installation whose template is named something
//! else — an older import, or a site that renamed it — names it in
//! `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` instead of this being a code change. Its macros say
//! where it is and how to sign in:
//!
//! | macro                        | meaning                                               |
//! |------------------------------|-------------------------------------------------------|
//! | `{$ELASTICSEARCH.SCHEME}`    | http / https                                          |
//! | `{$ELASTICSEARCH.HOST}`      | host or IP                                            |
//! | `{$ELASTICSEARCH.PORT}`      | port                                                  |
//! | `{$ELASTICSEARCH.USERNAME}`  | user                                                  |
//! | `{$ELASTICSEARCH.PASSWORD}`  | a *Vault* macro (`mount/path:key`) — read from Vault  |
//! | `{$ELASTICSEARCH.JUMPHOST}`  | an ElasticPro jump host id; empty = direct        |
//! | `{$WJ.HOST}`, `{$WJ.PORT}`   | the Windows jump host Zabbix itself goes through      |
//! | `{$GRP.CLIENT}`              | the client this cluster belongs to                    |
//!
//! A host macro wins over the template's, and the template's over a global one — Zabbix's
//! own order. A password stored as a *Secret* macro is reported as unreadable, because it
//! is: Zabbix does not return those through its API, to anyone.
//!
//! Who may see the cluster is Zabbix's answer too. A Zabbix user group that can read any
//! of the host's host groups, and is denied none of them, sees it — the same rule Zabbix
//! applies to the host itself, so a person sees the same clusters in both places.

use crate::tls::{PinStore, PinningVerifier, TlsMode, MARK_PIN_MISMATCH, MARK_UNTRUSTED};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Only the default. `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` wins over it, so an installation
/// whose template carries another name keeps working without a rebuild.
pub const DEFAULT_TEMPLATE: &str = "Elasticsearch Cluster by HTTP EP";
/// Cluster Management links this instead of the HTTP template for a cluster behind a Windows
/// jump host (integration/zabbix/clients-module/lib/JumpTemplate.php, NAME).
pub const JUMP_TEMPLATE: &str = "ElasticPro Elasticsearch via SSH jump host";

/// Which of ElasticPro's jump hosts (id, address, port) is the one Zabbix goes through.
/// Addresses compare without case; the port must match.
pub fn match_jump<'a>(addr: &(String, u16), jumps: impl IntoIterator<Item = (&'a str, &'a str, u16)>) -> Option<String> {
    jumps.into_iter().find(|(_, h, p)| h.eq_ignore_ascii_case(&addr.0) && *p == addr.1).map(|(id, _, _)| id.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub enum PasswordRef {
    /// A Vault macro's value: where the password is, not the password.
    Vault(String),
    /// A plain-text macro. Works, and anyone who can read the host's macros can read it.
    Plain(String),
    /// A Secret macro. Zabbix will not return it; ElasticPro cannot use it.
    SecretMacro,
    Missing,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ZbxCluster {
    pub hostid: String,
    /// The host's technical name — stable, so the cluster id built from it is too.
    pub host: String,
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: PasswordRef,
    pub jump: Option<String>,
    /// The jump host Zabbix reaches the cluster through (Cluster Management's "Windows jump
    /// host"), as address and SSH port — matched to one of ElasticPro's own jump hosts.
    pub jump_addr: Option<(String, u16)>,
    pub client: Option<String>,
    /// Zabbix user groups that may see it.
    pub readers: Vec<String>,
}

impl ZbxCluster {
    /// The id this cluster has in ElasticPro. Prefixed, so it can never collide with
    /// one derived from a config file's cluster name.
    pub fn id(&self) -> String {
        format!("zbx-{}", slug(&self.host))
    }
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for ch in s.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Macro name → (type, value), with Zabbix's precedence: host over template over global.
/// Context macros (`{$X:ctx}`) are left out; nothing here reads one.
pub fn resolve_macros(host: &[Value], template: &[Value], global: &[Value]) -> HashMap<String, (i64, String)> {
    let mut out = HashMap::new();
    for layer in [global, template, host] {
        for m in layer {
            let Some(name) = m["macro"].as_str() else { continue };
            if name.contains(':') {
                continue;
            }
            let ty = m["type"].as_str().and_then(|t| t.parse().ok()).or_else(|| m["type"].as_i64()).unwrap_or(0);
            out.insert(name.to_string(), (ty, m["value"].as_str().unwrap_or("").to_string()));
        }
    }
    out
}

/// The cluster a host describes, or why it does not describe one.
pub fn cluster_from(host: &Value, macros: &HashMap<String, (i64, String)>, readers: Vec<String>) -> Result<ZbxCluster, String> {
    let get = |k: &str| macros.get(k).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty());
    let hostname = host["host"].as_str().unwrap_or("").to_string();
    let es_host = get("{$ELASTICSEARCH.HOST}")
        .filter(|h| !h.starts_with('<'))                  // the template's "<SET ELASTICSEARCH HOST>"
        .ok_or_else(|| format!("{hostname}: {{$ELASTICSEARCH.HOST}} is not set"))?;
    let scheme = get("{$ELASTICSEARCH.SCHEME}").unwrap_or_else(|| "https".into()).to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("{hostname}: {{$ELASTICSEARCH.SCHEME}} must be http or https, not {scheme:?}"));
    }
    let port = get("{$ELASTICSEARCH.PORT}").unwrap_or_else(|| "9200".into());
    if port.parse::<u16>().is_err() {
        return Err(format!("{hostname}: {{$ELASTICSEARCH.PORT}} is not a port: {port:?}"));
    }
    // A host macro holding a whole URL is taken as one rather than doubled up.
    let url = if es_host.contains("://") { es_host.trim_end_matches('/').to_string() } else { format!("{scheme}://{es_host}:{port}") };
    let password = match macros.get("{$ELASTICSEARCH.PASSWORD}") {
        None => PasswordRef::Missing,
        Some((2, v)) if !v.trim().is_empty() => PasswordRef::Vault(v.trim().to_string()),
        Some((1, _)) => PasswordRef::SecretMacro,
        Some((0, v)) if !v.is_empty() => PasswordRef::Plain(v.clone()),
        Some(_) => PasswordRef::Missing,
    };
    Ok(ZbxCluster {
        hostid: host["hostid"].as_str().unwrap_or("").to_string(),
        host: hostname.clone(),
        name: host["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(&hostname).to_string(),
        url,
        username: get("{$ELASTICSEARCH.USERNAME}").unwrap_or_default(),
        password,
        jump: get("{$ELASTICSEARCH.JUMPHOST}"),
        jump_addr: get("{$WJ.HOST}").map(|h| (h, get("{$WJ.PORT}").and_then(|p| p.parse().ok()).unwrap_or(22))),
        client: get("{$GRP.CLIENT}"),
        readers,
    })
}

/// User groups that may read a host in these host groups: read or read-write on at least
/// one, deny on none. Disabled user groups see nothing.
pub fn readers(host_groupids: &[String], usergroups: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = usergroups.iter().filter(|ug| ug["users_status"].as_str() != Some("1")).filter_map(|ug| {
        let rights: HashMap<String, i64> = ug["hostgroup_rights"].as_array().into_iter().flatten().filter_map(|r| {
            let id = r["id"].as_str()?.to_string();
            let p = r["permission"].as_str().and_then(|p| p.parse().ok()).or_else(|| r["permission"].as_i64())?;
            Some((id, p))
        }).collect();
        let denied = host_groupids.iter().any(|g| rights.get(g) == Some(&0));
        let allowed = host_groupids.iter().any(|g| matches!(rights.get(g), Some(2) | Some(3)));
        (allowed && !denied).then(|| ug["name"].as_str().unwrap_or("").to_string())
    }).filter(|n| !n.is_empty()).collect();
    out.sort();
    out
}

/// A Zabbix host's technical name from a cluster name. Zabbix allows letters, digits,
/// spaces, dots, dashes and underscores; anything else becomes a dash.
pub fn technical_name(s: &str) -> String {
    let t: String = s.trim().chars().map(|c| if c.is_ascii_alphanumeric() || " .-_".contains(c) { c } else { '-' }).collect();
    if t.is_empty() { "cluster".into() } else { t }
}

/// `http://es.example:9200/` → ("http", "es.example", "9200"), with the scheme's default
/// port when none is written.
pub fn split_url(url: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.split('/').next()?.rsplit('@').next()?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() && !h.is_empty() => (h.to_string(), p.to_string()),
        _ => (authority.to_string(), if scheme == "https" { "443".into() } else { "80".into() }),
    };
    (!host.is_empty() && (scheme == "http" || scheme == "https")).then_some((scheme, host, port))
}

/// What a created cluster host carries.
#[derive(Debug, Clone)]
pub struct NewHost {
    pub host: String,
    pub name: String,
    pub scheme: String,
    pub es_host: String,
    pub port: String,
    pub username: Option<String>,
    /// A Vault reference, never a password.
    pub password_ref: Option<String>,
    pub client: String,
    pub group_ids: Vec<String>,
    pub template_ids: Vec<String>,
}

pub struct Zabbix {
    url: Option<String>,
    token: String,
    template: String,
    http: reqwest::Client,
    /// The pin store the TLS verifier records into, so a failed handshake can show the
    /// certificate it saw; and the `host:port` it records under.
    pins: Option<Arc<PinStore>>,
    key: String,
}

/// Why the Zabbix API could not be used, in the kinds Config → Zabbix acts on.
#[derive(Debug, Clone)]
pub struct ApiError {
    /// `dns`, `timeout`, `connection_refused`, `tls_untrusted`, `tls_pin_mismatch`,
    /// `tls_error`, `network`, `http_error`, `not_zabbix`, `auth`, `zabbix_error`,
    /// `not_configured`.
    pub kind: &'static str,
    pub message: String,
    /// The certificate presented, for the trust decision (`tls_*`).
    pub cert: Option<Box<crate::tls::CertInfo>>,
    pub pinned: Option<String>,
}

impl ApiError {
    fn new(kind: &'static str, message: impl Into<String>) -> ApiError {
        ApiError { kind, message: message.into(), cert: None, pinned: None }
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({ "ok": false, "kind": self.kind, "message": self.message });
        if let Some(c) = &self.cert {
            v["cert"] = serde_json::to_value(c).unwrap_or(Value::Null);
        }
        if let Some(p) = &self.pinned {
            v["pinned"] = json!(p);
        }
        v
    }
}

impl Zabbix {
    /// `ELASTICPRO_ZABBIX_API_URL`, `ELASTICPRO_ZABBIX_API_TOKEN_FILE`, and
    /// `ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE` for a template Zabbix knows under another name
    /// (unset = [`DEFAULT_TEMPLATE`]).
    pub fn from_env() -> Zabbix {
        let token = std::env::var("ELASTICPRO_ZABBIX_API_TOKEN_FILE").ok()
            .and_then(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string()).unwrap_or_default();
        Zabbix::new(
            std::env::var("ELASTICPRO_ZABBIX_API_URL").ok().filter(|s| !s.trim().is_empty()),
            token,
            std::env::var("ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE").ok().filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_TEMPLATE.to_string()),
        )
    }

    /// The same API, with the write token (`ELASTICPRO_ZABBIX_API_WRITE_TOKEN_FILE`) used only
    /// to create hosts. Unconfigured when that file is not set.
    pub fn writer_from_env() -> Zabbix {
        let token = std::env::var("ELASTICPRO_ZABBIX_API_WRITE_TOKEN_FILE").ok()
            .and_then(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string()).unwrap_or_default();
        Zabbix::new(std::env::var("ELASTICPRO_ZABBIX_API_URL").ok().filter(|s| !s.trim().is_empty()), token, String::new())
    }

    pub fn new(url: Option<String>, token: String, template: String) -> Zabbix {
        // Zabbix frontends on self-signed certificates are the common case on a private
        // network; the token is sent to the address an admin configured, nowhere else.
        let insecure = std::env::var("ELASTICPRO_ZABBIX_API_INSECURE").is_ok_and(|v| v == "1");
        Zabbix::build(url, token, template, !insecure, None)
    }

    /// The client the core uses: `verify_tls` off accepts any certificate (a lab); on, the
    /// OS store and — with `pins` — the same trust-on-first-use pins the clusters use, so a
    /// self-signed Zabbix is trusted by the operator pressing *Trust* on the certificate
    /// Config → Zabbix shows them, exactly as for a cluster. No second trust store.
    pub fn build(url: Option<String>, token: String, template: String, verify_tls: bool, pins: Option<Arc<PinStore>>) -> Zabbix {
        let mut b = reqwest::Client::builder().timeout(Duration::from_secs(15)).connect_timeout(Duration::from_secs(8))
            .no_proxy()
            .user_agent(format!("ElasticPro/{}", crate::VERSION));
        let key = url.as_deref().map(crate::http::host_key).unwrap_or_default();
        match &pins {
            Some(p) => {
                let mode = if verify_tls { TlsMode::Auto } else { TlsMode::Insecure };
                b = b.use_preconfigured_tls(PinningVerifier::new(p.clone(), mode, key.clone()).client_config());
            }
            None => b = b.danger_accept_invalid_certs(!verify_tls),
        }
        let http = b.build().expect("reqwest client");
        Zabbix { url, token, template, http, pins, key }
    }

    pub fn configured(&self) -> bool {
        self.url.is_some() && !self.token.is_empty()
    }

    pub fn template(&self) -> &str {
        &self.template
    }

    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_as(method, params, true).await.map_err(|e| match e.kind {
            "zabbix_error" | "auth" => e.message,
            "not_zabbix" => format!("Zabbix API answered something that is not JSON: {}", e.message),
            _ => format!("Zabbix API unreachable: {}", e.message),
        })
    }

    /// One JSON-RPC call. `auth` false sends no token — `apiinfo.version` refuses one.
    async fn call_as(&self, method: &str, params: Value, auth: bool) -> Result<Value, ApiError> {
        let url = self.url.as_deref().ok_or_else(|| ApiError::new("not_configured", "the Zabbix API address is not set"))?;
        let mut rb = self.http.post(url).json(&json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": 1 }));
        if auth {
            rb = rb.bearer_auth(&self.token);
        }
        let res = rb.send().await.map_err(|e| self.classify(&e))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| self.classify(&e))?;
        let body: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) if !status.is_success() => {
                return Err(ApiError::new("http_error", format!("HTTP {} from {url}", status.as_u16())));
            }
            Err(e) => return Err(ApiError::new("not_zabbix", format!("{url} did not answer JSON-RPC ({e}) — is this the api_jsonrpc.php address?"))),
        };
        if let Some(err) = body.get("error") {
            let msg = err["data"].as_str().or(err["message"].as_str()).unwrap_or("error").to_string();
            let low = msg.to_ascii_lowercase();
            let kind = if low.contains("not authori") || low.contains("session terminated") || low.contains("re-login")
                || low.contains("token") || low.contains("permission") { "auth" } else { "zabbix_error" };
            return Err(ApiError::new(kind, format!("Zabbix {method}: {msg}")));
        }
        if body.get("result").is_none() {
            return Err(ApiError::new("not_zabbix", format!("{url} answered JSON without a JSON-RPC result")));
        }
        Ok(body["result"].clone())
    }

    fn classify(&self, e: &reqwest::Error) -> ApiError {
        let mut chain = e.to_string();
        let mut src: Option<&dyn std::error::Error> = std::error::Error::source(e);
        while let Some(x) = src {
            chain.push_str(" | ");
            chain.push_str(&x.to_string());
            src = x.source();
        }
        let dbg = format!("{e:?}");
        let low = chain.to_ascii_lowercase();
        let cert = self.pins.as_ref().and_then(|p| p.last_seen(&self.key));
        let pinned = self.pins.as_ref().and_then(|p| p.cert_pin(&self.key)).map(|p| p.sha256);
        let (kind, message) = if e.is_timeout() {
            ("timeout", "no answer in time — a firewall dropping packets, or the wrong address".to_string())
        } else if dbg.contains(MARK_UNTRUSTED) || chain.contains(MARK_UNTRUSTED) {
            ("tls_untrusted", "the Zabbix certificate is not trusted by the OS store and has not been pinned".to_string())
        } else if dbg.contains(MARK_PIN_MISMATCH) || chain.contains(MARK_PIN_MISMATCH) {
            ("tls_pin_mismatch", "the Zabbix certificate CHANGED since it was pinned; the token was not sent".to_string())
        } else if low.contains("dns") || low.contains("failed to lookup") || low.contains("name or service not known") || low.contains("no such host") {
            ("dns", format!("the name does not resolve from the ElasticPro server: {chain}"))
        } else if low.contains("connection refused") {
            ("connection_refused", "connection refused — nothing listens on that port".to_string())
        } else if low.contains("certificate") || low.contains("handshake") || low.contains("tls") || low.contains("ssl") {
            ("tls_error", format!("TLS failed: {chain}"))
        } else {
            ("network", chain)
        };
        let mut out = ApiError::new(kind, message);
        if kind.starts_with("tls_") {
            out.cert = cert.map(Box::new);
            out.pinned = pinned;
        }
        out
    }

    /// `ZABBIX_LINK_TEST`: can this address and token be used? Asks `apiinfo.version`
    /// (unauthenticated), then an authenticated read of the cluster template — which proves
    /// the token works and whether the template the sync looks for exists.
    pub async fn probe(&self) -> Value {
        if self.url.is_none() {
            return ApiError::new("not_configured", "set the Zabbix URL (or the API URL) first").to_json();
        }
        let version = match self.call_as("apiinfo.version", json!([]), false).await {
            Ok(v) => v.as_str().unwrap_or("").to_string(),
            Err(e) => return e.to_json(),
        };
        if self.token.is_empty() {
            return json!({ "ok": false, "kind": "no_token", "version": version,
                           "message": format!("Zabbix {version} answers; no API token is set yet — pair, or paste one") });
        }
        match self.call_as("template.get", json!({ "filter": { "host": [&self.template] }, "output": ["templateid"] }), true).await {
            Ok(t) => {
                let found = t.as_array().is_some_and(|a| !a.is_empty());
                json!({ "ok": true, "version": version, "authOk": true, "template": { "name": self.template, "found": found },
                        "message": if found { format!("Zabbix {version}: the token works and the template is there") }
                                   else { format!("Zabbix {version}: the token works, but no template named {:?} is visible to it", self.template) } })
            }
            Err(e) => {
                let mut v = e.to_json();
                v["version"] = json!(version);
                v
            }
        }
    }

    /// The latest value of each named item on one host: key → (value, unix clock). Only
    /// keys under `es.` and `elasticpro.` are asked for — the Elasticsearch template's and this
    /// app's own — whatever the caller named.
    pub async fn latest(&self, hostid: &str, keys: &[String]) -> Result<Value, String> {
        let keys: Vec<&String> = keys.iter().filter(|k| k.starts_with("es.") || k.starts_with("elasticpro.")).take(64).collect();
        if keys.is_empty() {
            return Ok(json!({}));
        }
        let items = self.call("item.get", json!({
            "hostids": [hostid], "output": ["key_", "lastvalue", "lastclock"], "filter": { "key_": keys },
        })).await?;
        let mut out = serde_json::Map::new();
        for i in items.as_array().into_iter().flatten() {
            let clock: u64 = i["lastclock"].as_str().and_then(|c| c.parse().ok()).unwrap_or(0);
            if clock == 0 {
                continue;                      // never received a value: unknown, not zero
            }
            if let Some(k) = i["key_"].as_str() {
                out.insert(k.to_string(), json!({ "value": i["lastvalue"], "clock": clock }));
            }
        }
        Ok(Value::Object(out))
    }

    /// A host group's id, creating it when it does not exist.
    pub async fn ensure_group(&self, name: &str) -> Result<String, String> {
        let g = self.call("hostgroup.get", json!({ "filter": { "name": [name] }, "output": ["groupid"] })).await?;
        if let Some(id) = g.as_array().and_then(|a| a.first()).and_then(|x| x["groupid"].as_str()) {
            return Ok(id.to_string());
        }
        let r = self.call("hostgroup.create", json!({ "name": name })).await?;
        r["groupids"][0].as_str().map(String::from).ok_or_else(|| format!("hostgroup.create for {name:?} returned no id"))
    }

    pub async fn template_id(&self, name: &str) -> Result<Option<String>, String> {
        let t = self.call("template.get", json!({ "filter": { "host": [name] }, "output": ["templateid"] })).await?;
        Ok(t.as_array().and_then(|a| a.first()).and_then(|x| x["templateid"].as_str()).map(String::from))
    }

    pub async fn host_exists(&self, host: &str) -> Result<bool, String> {
        let h = self.call("host.get", json!({ "filter": { "host": [host] }, "output": ["hostid"] })).await?;
        Ok(h.as_array().is_some_and(|a| !a.is_empty()))
    }

    /// Create a cluster host. Its password is only ever a Vault reference.
    pub async fn create_host(&self, n: &NewHost) -> Result<String, String> {
        let mut macros = vec![
            json!({ "macro": "{$ELASTICSEARCH.SCHEME}", "value": n.scheme }),
            json!({ "macro": "{$ELASTICSEARCH.HOST}", "value": n.es_host }),
            json!({ "macro": "{$ELASTICSEARCH.PORT}", "value": n.port }),
            json!({ "macro": "{$GRP.CLIENT}", "value": n.client }),
        ];
        if let Some(u) = &n.username {
            macros.push(json!({ "macro": "{$ELASTICSEARCH.USERNAME}", "value": u }));
        }
        if let Some(r) = &n.password_ref {
            macros.push(json!({ "macro": "{$ELASTICSEARCH.PASSWORD}", "value": r, "type": 2 }));
        }
        let r = self.call("host.create", json!({
            "host": n.host, "name": n.name,
            "groups": n.group_ids.iter().map(|g| json!({ "groupid": g })).collect::<Vec<_>>(),
            "templates": n.template_ids.iter().map(|t| json!({ "templateid": t })).collect::<Vec<_>>(),
            "macros": macros,
            "tags": [{ "tag": "source", "value": "elasticpro" }, { "tag": "client", "value": n.client }],
            "description": "Created by ElasticPro from its config (zabbix.createHosts). Edit it here: Zabbix wins.",
        })).await?;
        r["hostids"][0].as_str().map(String::from).ok_or_else(|| "host.create returned no id".into())
    }

    /// Let a user group read a host group — only ever raising "no access" to read. An
    /// existing read-write, or a deny somebody set on purpose, is left exactly as it is.
    pub async fn grant_read(&self, usergroup: &str, groupid: &str) -> Result<bool, String> {
        let ug = self.call("usergroup.get", json!({ "filter": { "name": [usergroup] }, "output": ["usrgrpid"],
                                                    "selectHostGroupRights": "extend" })).await?;
        let Some(ug) = ug.as_array().and_then(|a| a.first()).cloned() else { return Ok(false) };
        let mut rights: Vec<Value> = ug["hostgroup_rights"].as_array().cloned().unwrap_or_default();
        if rights.iter().any(|r| r["id"].as_str() == Some(groupid)) {
            return Ok(false);
        }
        rights.push(json!({ "id": groupid, "permission": 2 }));
        self.call("usergroup.update", json!({ "usrgrpid": ug["usrgrpid"], "hostgroup_rights": rights })).await?;
        Ok(true)
    }

    /// Every enabled host carrying the cluster template — or Cluster Management's template for
    /// clusters behind a Windows jump host — and the hosts that do not make sense as a
    /// cluster, with why.
    pub async fn clusters(&self) -> Result<(Vec<ZbxCluster>, Vec<String>), String> {
        let tpls = self.call("template.get", json!({ "filter": { "host": [&self.template, JUMP_TEMPLATE] },
                                                     "output": ["templateid", "host"], "selectMacros": ["macro", "value", "type"] })).await?;
        let empty = vec![];
        let tpls = tpls.as_array().unwrap_or(&empty);
        if !tpls.iter().any(|t| t["host"].as_str() == Some(self.template.as_str())) {
            return Err(format!("no template named {:?} in Zabbix", self.template));
        }
        let globals = self.call("usermacro.get", json!({ "globalmacro": true, "output": ["macro", "value", "type"] })).await?;
        let ugs = self.call("usergroup.get", json!({ "output": ["name", "users_status"], "selectHostGroupRights": "extend" })).await?;
        let (gm, ugs) = (globals.as_array().unwrap_or(&empty), ugs.as_array().unwrap_or(&empty));
        let mut ok = vec![];
        let mut skipped = vec![];
        let mut seen = std::collections::HashSet::new();
        for tpl in tpls {
            let hosts = self.call("host.get", json!({
                "templateids": [tpl["templateid"]], "filter": { "status": 0 },
                "output": ["hostid", "host", "name"], "selectMacros": ["macro", "value", "type"],
                "selectHostGroups": ["groupid", "name"],
            })).await?;
            let tm = tpl["macros"].as_array().unwrap_or(&empty);
            for h in hosts.as_array().unwrap_or(&empty) {
                if !seen.insert(h["hostid"].as_str().unwrap_or("").to_string()) {
                    continue;
                }
                let groups: Vec<String> = h["hostgroups"].as_array().into_iter().flatten()
                    .filter_map(|g| g["groupid"].as_str().map(String::from)).collect();
                let macros = resolve_macros(h["macros"].as_array().unwrap_or(&empty), tm, gm);
                match cluster_from(h, &macros, readers(&groups, ugs)) {
                    Ok(c) => ok.push(c),
                    Err(why) => skipped.push(why),
                }
            }
        }
        Ok((ok, skipped))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(name: &str, value: &str, ty: &str) -> Value {
        json!({ "macro": name, "value": value, "type": ty })
    }

    fn host() -> Value {
        json!({ "hostid": "10700", "host": "vm-1 cluster", "name": "vm-1 cluster" })
    }

    #[test]
    fn host_macros_win_over_template_and_global() {
        let r = resolve_macros(
            &[m("{$ELASTICSEARCH.HOST}", "10.0.0.5", "0")],
            &[m("{$ELASTICSEARCH.HOST}", "<SET ELASTICSEARCH HOST>", "0"), m("{$ELASTICSEARCH.PORT}", "9200", "0")],
            &[m("{$ELASTICSEARCH.PORT}", "9999", "0"), m("{$ELASTICSEARCH.SCHEME}", "http", "0")],
        );
        assert_eq!(r["{$ELASTICSEARCH.HOST}"].1, "10.0.0.5");
        assert_eq!(r["{$ELASTICSEARCH.PORT}"].1, "9200", "the template beats a global");
        assert_eq!(r["{$ELASTICSEARCH.SCHEME}"].1, "http", "a global fills what nothing else sets");
    }

    #[test]
    fn a_host_becomes_a_cluster() {
        let mac = resolve_macros(&[
            m("{$ELASTICSEARCH.HOST}", "203.0.113.12", "0"), m("{$ELASTICSEARCH.SCHEME}", "http", "0"),
            m("{$ELASTICSEARCH.PORT}", "9200", "0"), m("{$ELASTICSEARCH.USERNAME}", "elastic", "0"),
            m("{$ELASTICSEARCH.PASSWORD}", "secret/elasticpro/vm-1:password", "2"),
            m("{$ELASTICSEARCH.JUMPHOST}", "jumpwin", "0"), m("{$GRP.CLIENT}", "vm-1", "0"),
        ], &[], &[]);
        let c = cluster_from(&host(), &mac, vec!["ES vm-1".into()]).unwrap();
        assert_eq!(c.url, "http://203.0.113.12:9200");
        assert_eq!(c.password, PasswordRef::Vault("secret/elasticpro/vm-1:password".into()));
        assert_eq!(c.jump.as_deref(), Some("jumpwin"));
        assert_eq!(c.client.as_deref(), Some("vm-1"));
        assert_eq!(c.id(), "zbx-vm-1-cluster");
    }

    #[test]
    fn a_secret_macro_is_reported_as_unreadable_not_empty() {
        let mac = resolve_macros(&[m("{$ELASTICSEARCH.HOST}", "es", "0"), m("{$ELASTICSEARCH.PASSWORD}", "", "1")], &[], &[]);
        assert_eq!(cluster_from(&host(), &mac, vec![]).unwrap().password, PasswordRef::SecretMacro);
    }

    #[test]
    fn a_host_that_is_not_filled_in_is_skipped_with_a_reason() {
        let unset = resolve_macros(&[], &[m("{$ELASTICSEARCH.HOST}", "<SET ELASTICSEARCH HOST>", "0")], &[]);
        assert!(cluster_from(&host(), &unset, vec![]).unwrap_err().contains("is not set"));
        let bad = resolve_macros(&[m("{$ELASTICSEARCH.HOST}", "es", "0"), m("{$ELASTICSEARCH.SCHEME}", "ftp", "0")], &[], &[]);
        assert!(cluster_from(&host(), &bad, vec![]).is_err());
        let port = resolve_macros(&[m("{$ELASTICSEARCH.HOST}", "es", "0"), m("{$ELASTICSEARCH.PORT}", "92x", "0")], &[], &[]);
        assert!(cluster_from(&host(), &port, vec![]).is_err());
    }

    #[test]
    fn readers_follow_zabbix_permissions() {
        let ugs = vec![
            json!({ "name": "ES vm-1", "users_status": "0", "hostgroup_rights": [{ "id": "30", "permission": "2" }] }),
            json!({ "name": "NOC", "users_status": "0", "hostgroup_rights": [{ "id": "30", "permission": "3" }, { "id": "31", "permission": "0" }] }),
            json!({ "name": "Other client", "users_status": "0", "hostgroup_rights": [{ "id": "40", "permission": "2" }] }),
            json!({ "name": "Disabled", "users_status": "1", "hostgroup_rights": [{ "id": "30", "permission": "3" }] }),
        ];
        assert_eq!(readers(&["30".into()], &ugs), vec!["ES vm-1", "NOC"]);
        // A deny on any of the host's groups wins, as it does in Zabbix.
        assert_eq!(readers(&["30".into(), "31".into()], &ugs), vec!["ES vm-1"]);
        assert!(readers(&["99".into()], &ugs).is_empty());
    }

    #[test]
    fn a_cluster_behind_the_windows_jump_host_names_it() {
        let m: HashMap<String, (i64, String)> = [("{$ELASTICSEARCH.HOST}", "10.1.0.5"), ("{$WJ.HOST}", "Jump-Win.acme.local"), ("{$WJ.PORT}", "2222")]
            .into_iter().map(|(k, v)| (k.to_string(), (0, v.to_string()))).collect();
        let c = cluster_from(&json!({ "hostid": "9", "host": "acme-ES-Cluster" }), &m, vec![]).unwrap();
        assert_eq!(c.jump_addr, Some(("Jump-Win.acme.local".to_string(), 2222)));
        assert_eq!(c.jump, None);
        // Port 22 when the page left it out.
        let mut m2 = m.clone();
        m2.remove("{$WJ.PORT}");
        assert_eq!(cluster_from(&json!({ "hostid": "9", "host": "a" }), &m2, vec![]).unwrap().jump_addr.unwrap().1, 22);
        // Matched to one of ElasticPro's jump hosts by address (any case) and port.
        let jumps = [("dc-jump", "jump-win.acme.local", 2222u16), ("other", "jump-win.acme.local", 22)];
        assert_eq!(match_jump(&c.jump_addr.clone().unwrap(), jumps.iter().copied()), Some("dc-jump".into()));
        assert_eq!(match_jump(&("elsewhere".into(), 22), jumps.iter().copied()), None);
    }

    #[test]
    fn ids_are_stable_and_prefixed() {
        assert_eq!(slug("  ACME Prod / DR  "), "acme-prod-dr");
        let c = ZbxCluster { hostid: "1".into(), host: "Prod ES".into(), name: "x".into(), url: String::new(),
                             username: String::new(), password: PasswordRef::Missing, jump: None, jump_addr: None, client: None, readers: vec![] };
        assert_eq!(c.id(), "zbx-prod-es");
    }
}
