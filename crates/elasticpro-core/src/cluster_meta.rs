//! What kind of cluster each one is: CI, DI or On-Prem; whether its logs are archived to S3
//! (ULM) and to which bucket; and whether SLM snapshots are expected of it at all.
//!
//! CI and DI clusters keep their logs in S3 through ULM and take no snapshots, so "SLM not
//! found" and "no recent snapshot" on them are noise; an On-Prem cluster is backed up by SLM
//! and those rules are exactly what it needs. The type decides the defaults (CI / DI: ULM
//! on, SLM none; On-Prem: ULM off, SLM expected), and an admin may override either.
//!
//! Hosted only: one store for every cluster, Zabbix ones too, `<data dir>/cluster-meta.json`,
//! 0600, written by tmp + rename. A Zabbix cluster with no entry here takes its type from
//! the host tag `elasticpro:type` (seeded in the sync; see `bridge::zabbix_sync`). The desktop
//! build keeps the same three keys (`type`, `ulm`, `slm`) on the cluster in its config file.
//!
//! Only the bucket's NAME is kept. Whether the archive is complete is the Zabbix log archive
//! (S3) template's question; nothing in ElasticPro reads S3.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The store's file name in the data directory.
pub const META_FILE: &str = "cluster-meta.json";
/// The Zabbix host tag a cluster's type is seeded from.
pub const TYPE_TAG: &str = "elasticpro:type";
/// Stops one runaway script filling the file.
pub const MAX_ENTRIES: usize = 5000;
/// The cluster types, as kept.
pub const TYPES: [&str; 3] = ["ci", "di", "onprem"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ulm {
    /// `None`: follow the type's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The S3 bucket's name; empty when none was given.
    #[serde(default)]
    pub bucket: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// ci | di | onprem.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub ulm: Ulm,
    /// expected | none; `None`: follow the type's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slm: Option<String>,
    #[serde(default)]
    pub set_by: String,
    #[serde(default)]
    pub set_at: u64,
}

/// A type as an admin or a Zabbix tag may write it — "CI", "di", "On-Prem", "on_prem" —
/// to the kept spelling; `None` for anything else.
pub fn normalize_type(s: &str) -> Option<&'static str> {
    let k: String = s.trim().to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    match k.as_str() {
        "ci" => Some("ci"),
        "di" => Some("di"),
        "onprem" | "onpremise" | "onpremises" => Some("onprem"),
        _ => None,
    }
}

/// An S3 bucket name by the general-purpose bucket rules: 3–63 characters of lowercase
/// letters, digits, dots and hyphens; starting and ending with a letter or digit; no two
/// dots in a row; not shaped like an IP address. Empty is "no bucket named" and passes.
pub fn check_bucket(b: &str) -> Result<(), String> {
    if b.is_empty() {
        return Ok(());
    }
    if b.len() < 3 || b.len() > 63 {
        return Err("an S3 bucket name is 3 to 63 characters".into());
    }
    if !b.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-') {
        return Err("an S3 bucket name holds only lowercase letters, digits, dots and hyphens".into());
    }
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !edge(b.chars().next()) || !edge(b.chars().last()) {
        return Err("an S3 bucket name starts and ends with a letter or a digit".into());
    }
    if b.contains("..") {
        return Err("an S3 bucket name has no two dots in a row".into());
    }
    if b.parse::<std::net::Ipv4Addr>().is_ok() {
        return Err("an S3 bucket name is not an IP address".into());
    }
    Ok(())
}

/// Validate what CLUSTER_META_SET was sent and build the entry to keep. `body` is the
/// message's `meta` object: `{type, ulm: {enabled?, bucket?}, slm?}`.
pub fn parse(body: &serde_json::Value, by: &str, at: u64) -> Result<Meta, String> {
    let ty = body.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let kind = normalize_type(ty).ok_or_else(|| format!("type must be ci, di or onprem, not {ty:?}"))?;
    let ulm_v = body.get("ulm").cloned().unwrap_or(serde_json::Value::Null);
    let enabled = match ulm_v.get("enabled") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Bool(b)) => Some(*b),
        Some(other) => return Err(format!("ulm.enabled must be true, false or null, not {other}")),
    };
    let bucket = match ulm_v.get("bucket") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(other) => return Err(format!("ulm.bucket must be a bucket name, not {other}")),
    };
    check_bucket(&bucket)?;
    let slm = match body.get("slm") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if s == "expected" || s == "none" => Some(s.clone()),
        Some(other) => return Err(format!("slm must be \"expected\" or \"none\", not {other}")),
    };
    Ok(Meta { kind: kind.into(), ulm: Ulm { enabled, bucket }, slm, set_by: by.into(), set_at: at })
}

pub struct ClusterMeta {
    path: Option<PathBuf>,
    map: RwLock<BTreeMap<String, Meta>>,
}

impl ClusterMeta {
    pub fn open(path: Option<PathBuf>) -> ClusterMeta {
        let map = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<BTreeMap<String, Meta>>(&s).ok())
            .unwrap_or_default();
        ClusterMeta { path, map: RwLock::new(map) }
    }

    fn save(&self, map: &BTreeMap<String, Meta>) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension("json.tmp");
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
            let mut f = o.open(&tmp).map_err(|e| format!("{META_FILE}.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{META_FILE}: {e}")
        })
    }

    pub fn get(&self, id: &str) -> Option<Meta> {
        self.map.read().get(id).cloned()
    }

    pub fn all(&self) -> BTreeMap<String, Meta> {
        self.map.read().clone()
    }

    /// Keep `meta` for cluster `id`, or with `None` forget it (back to the Zabbix tag or the
    /// defaults). Written before it is believed: a failed write changes nothing.
    pub fn set(&self, id: &str, meta: Option<Meta>) -> Result<(), String> {
        let id = id.trim();
        if id.is_empty() || id.len() > 256 {
            return Err("clusterId must name a cluster".into());
        }
        let mut next = self.map.read().clone();
        match meta {
            Some(m) => {
                if !next.contains_key(id) && next.len() >= MAX_ENTRIES {
                    return Err(format!("at most {MAX_ENTRIES} clusters are kept"));
                }
                next.insert(id.to_string(), m);
            }
            None => {
                next.remove(id);
            }
        }
        self.save(&next)?;
        *self.map.write() = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn types_are_normalised_and_nothing_else_is_one() {
        for (s, want) in [("CI", "ci"), ("di", "di"), ("On-Prem", "onprem"), ("on_prem", "onprem"), ("onprem", "onprem"), (" DI ", "di")] {
            assert_eq!(normalize_type(s), Some(want), "{s}");
        }
        for s in ["", "prod", "c i x", "cloud"] {
            assert_eq!(normalize_type(s), None, "{s}");
        }
    }

    #[test]
    fn bucket_names_follow_the_s3_rules() {
        for ok in ["", "abc", "acme-logs", "acme.logs.2026", &"a".repeat(63)] {
            assert!(check_bucket(ok).is_ok(), "{ok}");
        }
        for bad in ["ab", &"a".repeat(64), "Acme", "acme_logs", "-acme", "acme-", ".acme", "acme..logs", "192.168.1.10", "acme logs", "s3://acme"] {
            assert!(check_bucket(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parse_takes_type_bucket_and_slm_and_refuses_the_rest() {
        let m = parse(&json!({ "type": "CI", "ulm": { "enabled": true, "bucket": " acme-logs " }, "slm": "none" }), "sara", 7).unwrap();
        assert_eq!((m.kind.as_str(), m.ulm.enabled, m.ulm.bucket.as_str(), m.slm.as_deref(), m.set_by.as_str(), m.set_at),
                   ("ci", Some(true), "acme-logs", Some("none"), "sara", 7));
        let m = parse(&json!({ "type": "onprem" }), "x", 1).unwrap();
        assert_eq!((m.ulm.enabled, m.slm), (None, None), "unsaid follows the type");
        assert!(parse(&json!({ "type": "prod" }), "x", 1).is_err());
        assert!(parse(&json!({}), "x", 1).is_err(), "a type is required");
        assert!(parse(&json!({ "type": "ci", "slm": "sometimes" }), "x", 1).is_err());
        assert!(parse(&json!({ "type": "ci", "ulm": { "enabled": "yes" } }), "x", 1).is_err());
        assert!(parse(&json!({ "type": "ci", "ulm": { "bucket": "Bad_Bucket" } }), "x", 1).is_err());
    }

    #[test]
    fn the_store_is_written_0600_by_rename_and_read_back() {
        let dir = std::env::temp_dir().join(format!("ep-meta-{}", crate::auth::random_hex(6)));
        let p = dir.join(META_FILE);
        let s = ClusterMeta::open(Some(p.clone()));
        let m = parse(&json!({ "type": "di", "ulm": { "bucket": "acme-logs" } }), "sara", 5).unwrap();
        s.set("c1", Some(m.clone())).unwrap();
        assert!(!p.with_extension("json.tmp").exists(), "no temporary file left behind");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let again = ClusterMeta::open(Some(p.clone()));
        assert_eq!(again.get("c1"), Some(m));
        again.set("c1", None).unwrap();
        assert_eq!(ClusterMeta::open(Some(p)).get("c1"), None, "forgotten on disk too");
        let _ = std::fs::remove_dir_all(dir);
    }
}
