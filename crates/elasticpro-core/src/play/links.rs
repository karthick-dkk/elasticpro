//! Display links (docs/PLAY.md "Display links"): a URL a TV opens to show Play without
//! anybody signing in on it.
//!
//! A link is a secret this core issued and can revoke, like an API token: only a SHA-256 of
//! the secret is kept (`<data>/play-links.json`, 0600), the secret is shown once when the
//! link is made, and a copy of the file is worth nothing to whoever reads it. Exchanging the
//! secret (`PLAY_EXCHANGE`) starts a session whose caller is `display:<name>`: the user role
//! for reads, `play_only` (auth::PLAY_READS), the link's clusters, and only from the link's
//! addresses. The session lives only as long as the link: the caller is rebuilt from the
//! link at every request, so revoking it, or its expiry, ends every TV on it at once.

use crate::auth::{ct_eq, random_hex, token_hash};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

/// The file, in the data directory.
pub const FILE: &str = "play-links.json";
/// The prefix makes a leaked display secret recognisable in a log or a paste.
pub const SECRET_PREFIX: &str = "epdisplay_";
/// At most this many links. A wall of TVs is a few dozen, not thousands.
pub const MAX_LINKS: usize = 200;
/// `lastSeen` is rewritten to disk at most this often per link, unless the address moved.
const SEEN_PERSIST_MS: u64 = 10 * 60_000;

/// Which clusters a link shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Clusters {
    /// By cluster id.
    Ids(Vec<String>),
    /// The clusters of one Zabbix user group (the same rule as a scoped account).
    Group { group: String },
    /// `"all"`.
    All(String),
}

impl Clusters {
    /// From the message: `"all"`, `{group}` or `[ids]`.
    pub fn parse(v: Option<&Value>) -> Result<Clusters, String> {
        match v {
            None | Some(Value::Null) => Ok(Clusters::All("all".into())),
            Some(Value::String(s)) if s.trim().eq_ignore_ascii_case("all") => Ok(Clusters::All("all".into())),
            Some(Value::Object(m)) => match m.get("group").and_then(Value::as_str).map(str::trim) {
                Some(g) if !g.is_empty() && g.len() <= 256 => Ok(Clusters::Group { group: g.to_string() }),
                _ => Err("clusters: {group} needs the name of a Zabbix user group".into()),
            },
            Some(Value::Array(a)) => {
                let mut ids: Vec<String> = vec![];
                for x in a {
                    let id = x.as_str().map(str::trim).unwrap_or("");
                    if id.is_empty() || id.len() > 256 {
                        return Err("clusters: every entry of the list must be a cluster id".into());
                    }
                    if !ids.iter().any(|i| i == id) {
                        ids.push(id.to_string());
                    }
                }
                if ids.is_empty() || ids.len() > 1000 {
                    return Err("clusters: name 1 to 1000 cluster ids, or \"all\", or {group}".into());
                }
                Ok(Clusters::Ids(ids))
            }
            _ => Err("clusters must be \"all\", {group: <Zabbix user group>} or a list of cluster ids".into()),
        }
    }

    /// The caller's Zabbix-group scope this link carries.
    pub fn scope(&self) -> Option<Vec<String>> {
        match self {
            Clusters::Group { group } => Some(vec![group.clone()]),
            _ => None,
        }
    }

    /// The cluster ids this link names, when it names them.
    pub fn ids(&self) -> Option<Vec<String>> {
        match self {
            Clusters::Ids(v) => Some(v.clone()),
            _ => None,
        }
    }
}

/// When and from where a link was last used.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    /// ms since the epoch.
    pub at: u64,
    /// The client address, as `source_of` decided it (trusted proxies honoured).
    pub from: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub name: String,
    /// SHA-256 of the secret, hex. Never leaves this file.
    hash: String,
    pub clusters: Clusters,
    #[serde(default)]
    pub allow_from: Vec<String>,
    /// ms since the epoch; `None`: permanent (until revoked).
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub created_at: u64,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub last_seen: Option<Seen>,
}

impl Link {
    pub fn expired(&self, now_ms: u64) -> bool {
        self.expires_at.is_some_and(|e| now_ms >= e)
    }

    /// What a page may be shown: everything but the hash.
    pub fn public(&self, now_ms: u64) -> Value {
        json!({
            "id": self.id, "name": self.name, "clusters": self.clusters, "allowFrom": self.allow_from,
            "expires": match self.expires_at { None => json!("permanent"), Some(at) => json!({ "at": at }) },
            "expiresAt": self.expires_at, "expired": self.expired(now_ms),
            "createdAt": self.created_at, "createdBy": self.created_by,
            "lastSeen": self.last_seen,
        })
    }

    /// The caller name its sessions carry.
    pub fn caller_name(&self) -> String {
        format!("display:{}", self.name)
    }
}

/// `expires`: `"permanent"` (the default) or a number of days, 1 to 3650.
pub fn parse_expires(v: Option<&Value>, now_ms: u64) -> Result<Option<u64>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().eq_ignore_ascii_case("permanent") => Ok(None),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(d) if (1..=3650).contains(&d) => Ok(Some(now_ms + d * 86_400_000)),
            _ => Err("expires: a number of days from 1 to 3650, or \"permanent\"".into()),
        },
        _ => Err("expires must be \"permanent\" or a number of days".into()),
    }
}

/// `allowFrom`: addresses or CIDRs, IPv4 or IPv6. Empty or absent: any address.
pub fn parse_allow_from(v: Option<&Value>) -> Result<Vec<String>, String> {
    let list: Vec<String> = match v {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().unwrap_or("").trim().to_string()).collect(),
        Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        _ => return Err("allowFrom must be a list of addresses or CIDRs".into()),
    };
    if list.len() > 64 {
        return Err("allowFrom: at most 64 entries".into());
    }
    for s in &list {
        crate::zbx_link::parse_source(s).map_err(|e| format!("allowFrom: {e}"))?;
    }
    Ok(list)
}

pub struct Links {
    path: Option<PathBuf>,
    list: RwLock<Vec<Link>>,
    /// When each link's `lastSeen` was last written to disk.
    seen_saved: parking_lot::Mutex<std::collections::HashMap<String, u64>>,
}

impl Links {
    pub fn open(path: Option<PathBuf>) -> Links {
        let list = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<Link>>(&s).ok())
            .unwrap_or_default();
        Links { path, list: RwLock::new(list), seen_saved: Default::default() }
    }

    fn save(&self) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_string_pretty(&*self.list.read()).map_err(|e| e.to_string())?;
        super::write_private(p, body.as_bytes())
    }

    pub fn list(&self) -> Vec<Link> {
        self.list.read().clone()
    }

    pub fn get(&self, id: &str) -> Option<Link> {
        self.list.read().iter().find(|l| l.id == id).cloned()
    }

    /// Make a link. Returns it and its secret, which is not kept and cannot be shown again.
    pub fn create(&self, name: &str, clusters: Clusters, allow_from: Vec<String>, expires_at: Option<u64>,
                  by: &str, now_ms: u64) -> Result<(Link, String), String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
            return Err("the link needs a name (up to 80 characters), so the TV can be recognised later".into());
        }
        if self.list.read().len() >= MAX_LINKS {
            return Err(format!("at most {MAX_LINKS} display links: revoke one first"));
        }
        if self.list.read().iter().any(|l| l.name.eq_ignore_ascii_case(name)) {
            return Err(format!("a display link named {name:?} exists already"));
        }
        let secret = format!("{SECRET_PREFIX}{}", random_hex(32));
        let link = Link {
            id: random_hex(8),
            name: name.to_string(),
            hash: token_hash(&secret),
            clusters,
            allow_from,
            expires_at,
            created_at: now_ms,
            created_by: by.to_string(),
            last_seen: None,
        };
        self.list.write().push(link.clone());
        if let Err(e) = self.save() {
            self.list.write().retain(|l| l.id != link.id);
            return Err(format!("the link could not be saved: {e}"));
        }
        Ok((link, secret))
    }

    pub fn revoke(&self, id: &str) -> Result<Option<Link>, String> {
        let gone = {
            let mut l = self.list.write();
            let i = l.iter().position(|x| x.id == id);
            i.map(|i| l.remove(i))
        };
        if gone.is_some() {
            self.save()?;
        }
        Ok(gone)
    }

    /// The link a secret names, whether or not it is still usable (the caller decides).
    pub fn by_secret(&self, secret: &str) -> Option<Link> {
        let secret = secret.trim();
        if secret.is_empty() || secret.len() > 256 {
            return None;
        }
        let want = token_hash(secret);
        self.list.read().iter().find(|l| ct_eq(l.hash.as_bytes(), want.as_bytes())).cloned()
    }

    /// Record a use. Kept in memory at once; written to disk when the address changed or the
    /// last write is older than ten minutes, so a TV asking every minute does not rewrite
    /// the file every minute.
    pub fn touch(&self, id: &str, now_ms: u64, from: Option<std::net::IpAddr>) {
        let from = from.map(|ip| ip.to_string());
        let moved = {
            let mut l = self.list.write();
            let Some(link) = l.iter_mut().find(|x| x.id == id) else { return };
            let moved = link.last_seen.as_ref().is_none_or(|s| s.from != from);
            link.last_seen = Some(Seen { at: now_ms, from });
            moved
        };
        let due = {
            let mut saved = self.seen_saved.lock();
            let last = saved.get(id).copied().unwrap_or(0);
            let due = moved || now_ms.saturating_sub(last) >= SEEN_PERSIST_MS;
            if due {
                saved.insert(id.to_string(), now_ms);
            }
            due
        };
        if due {
            let _ = self.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clusters_parse_all_group_and_ids() {
        assert_eq!(Clusters::parse(None).unwrap(), Clusters::All("all".into()));
        assert_eq!(Clusters::parse(Some(&json!("ALL"))).unwrap().scope(), None);
        let g = Clusters::parse(Some(&json!({ "group": " NOC " }))).unwrap();
        assert_eq!(g.scope(), Some(vec!["NOC".to_string()]));
        let ids = Clusters::parse(Some(&json!(["a", "b", "a"]))).unwrap();
        assert_eq!(ids.ids(), Some(vec!["a".to_string(), "b".to_string()]));
        for bad in [json!([]), json!([""]), json!({ "group": "" }), json!(7), json!("some")] {
            assert!(Clusters::parse(Some(&bad)).is_err(), "{bad}");
        }
        // Round trip through the file.
        for c in [Clusters::All("all".into()), g, ids] {
            let back: Clusters = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
            assert_eq!(back, c);
        }
    }

    #[test]
    fn expiry_and_addresses() {
        assert_eq!(parse_expires(None, 0).unwrap(), None, "permanent is the default");
        assert_eq!(parse_expires(Some(&json!("permanent")), 0).unwrap(), None);
        assert_eq!(parse_expires(Some(&json!(2)), 1000).unwrap(), Some(1000 + 2 * 86_400_000));
        assert!(parse_expires(Some(&json!(0)), 0).is_err());
        assert!(parse_expires(Some(&json!("soon")), 0).is_err());
        assert_eq!(parse_allow_from(Some(&json!(["10.0.0.0/24", "fd00::1"]))).unwrap().len(), 2);
        assert!(parse_allow_from(Some(&json!(["not-an-ip"]))).is_err());
        assert!(parse_allow_from(None).unwrap().is_empty());
    }

    #[test]
    fn only_a_hash_is_kept_and_the_secret_finds_its_link() {
        let dir = std::env::temp_dir().join(format!("ep-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join(FILE);
        let links = Links::open(Some(p.clone()));
        let (link, secret) = links.create("Lobby TV", Clusters::All("all".into()), vec![], None, "Admin", 5).unwrap();
        assert!(secret.starts_with(SECRET_PREFIX));
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains(&secret), "the secret is never written");
        assert!(!link.public(0).to_string().contains(&link.hash), "the hash never leaves the file");
        assert_eq!(Links::open(Some(p.clone())).by_secret(&secret).map(|l| l.id), Some(link.id.clone()));
        assert!(links.by_secret("epdisplay_wrong").is_none());
        assert!(links.create("lobby tv", Clusters::All("all".into()), vec![], None, "Admin", 5).is_err(), "names are unique");
        links.touch(&link.id, 99, Some("10.1.2.3".parse().unwrap()));
        assert_eq!(Links::open(Some(p.clone())).get(&link.id).unwrap().last_seen.unwrap().from.as_deref(), Some("10.1.2.3"));
        assert_eq!(links.revoke(&link.id).unwrap().map(|l| l.name), Some("Lobby TV".to_string()));
        assert!(Links::open(Some(p)).by_secret(&secret).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
