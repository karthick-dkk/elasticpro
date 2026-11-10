//! Edits made in ElasticPro to clusters that come from Zabbix — an overlay, never a write to
//! Zabbix.
//!
//! A Zabbix cluster is built from its Zabbix host at every sync (`bridge::zabbix_sync`). What an
//! operator or an admin changes about one in ElasticPro (Config-Management › Clusters › Edit) is
//! kept here, keyed by the Zabbix **host id** — stable across a rename of the host's name or of
//! its technical name — and laid over what Zabbix says at every sync:
//!
//! * **the address is never overridable.** It always comes from Zabbix (`{$ELASTICSEARCH.HOST}`,
//!   `PORT`, `SCHEME`), so a config-file cluster at the same address is still the one Zabbix's
//!   shadows, and a credential bound to the old address is not sent to a new one;
//! * every other field the Edit dialog has for a config-file cluster may be set: `FIELDS`. The
//!   core applies `name`, `via`, `tls` and `enabled` to what it polls (`POLLED`), and the
//!   capacity fields to the history store's capacity document; the pages read the rest
//!   (tags, note, retention, volume window) from the `ZABBIX_CLUSTERS` row the core builds;
//! * the overlay wins: when Zabbix changes a field the overlay also sets, the overlay's value is
//!   used, and the row says per field that it is set in ElasticPro (`overridden`) beside
//!   Zabbix's own value (`zabbixValues`). Resetting a field removes just that override;
//! * a cluster's own credential is NOT here: it is kept in the encrypted credential store
//!   (`cluster_secrets`, `cfg:<cluster id>`, bound to the cluster's destination — the address
//!   from Zabbix, the route and the certificate setting), set by `CREDENTIAL_SET` like a config
//!   cluster's own, and never sent back to a browser;
//! * an overlay whose host disappears from Zabbix is kept (orphaned) and shown nowhere; it
//!   applies again the moment the host returns.
//!
//! Hosted only: `<data dir>/zabbix-overrides.json`, 0600, written tmp + rename, beside
//! `cluster-meta.json`, and in the backup's *Clusters* section.

use crate::cluster_save::Refusal;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

/// The store's file name in the data directory.
pub const FILE: &str = "zabbix-overrides.json";
/// Stops one runaway script filling the file.
pub const MAX_ENTRIES: usize = 5000;

/// Every field an overlay may set: the Edit dialog's for a config-file cluster, but the address
/// (and the credential, which has its own store, and the type, which is `cluster_meta`'s).
pub const FIELDS: [&str; 12] = [
    "name", "via", "tls", "enabled", "tags", "note", "liveRetention", "snapshotRetention", "backupCapacity",
    "volumeWindowDays", "volumeTopDays", "volumeHeadroomPercent",
];
/// The fields the core applies to what it polls. The rest are the pages' and the reports'.
pub const POLLED: [&str; 4] = ["name", "via", "tls", "enabled"];
/// With the address, where the cluster's requests go: what a cluster's own credential is bound to.
pub const DESTINATION: [&str; 2] = ["via", "tls"];
/// What the address is called in a message; refused whatever its spelling.
const ADDRESS: [&str; 6] = ["url", "address", "host", "port", "scheme", "origin"];
/// A credential's keys; refused here, kept by `CREDENTIAL_SET`.
const CREDENTIAL: [&str; 8] = ["username", "user", "password", "apikey", "bearer", "credential", "credentials", "authheader"];
/// The cluster type, ULM and SLM; refused here, kept by `CLUSTER_META_SET`.
const KIND: [&str; 5] = ["type", "ulm", "slm", "logbucket", "kind"];

const MAX_NAME: usize = 128;
const MAX_NOTE: usize = 1000;
const MAX_TAGS: usize = 32;
const MAX_TAG: usize = 64;
const MAX_SIZE_TEXT: usize = 32;

/// One Zabbix cluster's overlay.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    /// Field → value, each one validated by `check_field`.
    #[serde(default)]
    pub fields: BTreeMap<String, Value>,
    #[serde(default)]
    pub set_by: String,
    #[serde(default)]
    pub set_at: u64,
    /// The cluster id (`zbx-<technical name>`) the host had when a sync last saw it: a rename of
    /// the technical name changes the id, and the credential kept under the old one follows.
    #[serde(default)]
    pub last_id: String,
    /// The host's technical name when a sync last saw it — for an orphan, the only name it has.
    #[serde(default)]
    pub host: String,
}

impl Overlay {
    pub fn get(&self, field: &str) -> Option<&Value> {
        self.fields.get(field)
    }
    fn text(&self, field: &str) -> Option<&str> {
        self.fields.get(field).and_then(Value::as_str)
    }
}

/// The value as it is kept, or why it is refused. Text is trimmed; tags are de-duplicated and
/// lose the `zabbix` marker the pages add themselves.
pub fn check_field(field: &str, v: &Value) -> Result<Value, String> {
    let text = |max: usize| -> Result<String, String> {
        let s = v.as_str().ok_or_else(|| format!("{field}: text"))?.trim().to_string();
        if s.is_empty() {
            return Err(format!("{field}: empty — use \"Use Zabbix's value\" (reset) to remove it"));
        }
        if s.chars().count() > max {
            return Err(format!("{field}: at most {max} characters"));
        }
        if s.chars().any(char::is_control) {
            return Err(format!("{field}: no control characters"));
        }
        Ok(s)
    };
    let whole = |min: i64, max: i64| -> Result<Value, String> {
        match v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)) {
            Some(n) if (min..=max).contains(&n) => Ok(json!(n)),
            _ => Err(format!("{field}: a whole number from {min} to {max}")),
        }
    };
    // A size or a duration as a person types it ("30d", "6 months", "2 TB"): the pages' parsers
    // (core/volume.js parseRetention / parseSize) are the one definition of what it means; here
    // only that it starts with a number and holds nothing a person would not type.
    let measure = || -> Result<Value, String> {
        let s = text(MAX_SIZE_TEXT)?;
        if !s.starts_with(|c: char| c.is_ascii_digit()) || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '.') {
            return Err(format!("{field}: a number and a unit, like 30d, 6M, 2TB"));
        }
        Ok(json!(s))
    };
    match field {
        "name" => Ok(json!(text(MAX_NAME)?)),
        "note" => Ok(json!(text(MAX_NOTE)?)),
        // "" is direct: a cluster Zabbix reaches through a jump host that ElasticPro reaches
        // without one. Whether the jump host exists is the caller's to check.
        "via" => {
            let s = v.as_str().ok_or("via: a jump host id, or \"\" for direct")?.trim();
            if s.len() > 64 || !s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
                return Err("via: a jump host id (letters, digits, . _ -), or \"\" for direct".into());
            }
            Ok(json!(s))
        }
        "tls" => match v.as_str().map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some(t @ ("auto" | "system" | "insecure")) => Ok(json!(t)),
            _ => Err("tls: auto, system or insecure".into()),
        },
        "enabled" => v.as_bool().map(|b| json!(b)).ok_or_else(|| "enabled: true or false".into()),
        "tags" => {
            let list = v.as_array().ok_or("tags: a list of words")?;
            let mut out: Vec<String> = vec![];
            for t in list {
                let s = t.as_str().ok_or("tags: a list of words")?.trim().to_string();
                if s.is_empty() || s.eq_ignore_ascii_case("zabbix") || out.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
                    continue;
                }
                if s.chars().count() > MAX_TAG || s.chars().any(char::is_control) {
                    return Err(format!("tags: each at most {MAX_TAG} characters"));
                }
                out.push(s);
            }
            if out.len() > MAX_TAGS {
                return Err(format!("tags: at most {MAX_TAGS}"));
            }
            Ok(json!(out))
        }
        "liveRetention" | "snapshotRetention" | "backupCapacity" => measure(),
        "volumeWindowDays" | "volumeTopDays" => whole(1, 90),
        "volumeHeadroomPercent" => whole(0, 200),
        _ => Err(format!("{field}: not a field ElasticPro keeps for a Zabbix cluster")),
    }
}

fn refusal(kind: &'static str, message: impl Into<String>) -> Refusal {
    Refusal { kind, message: message.into() }
}

/// A change as `ZABBIX_CLUSTER_SAVE` sends it: `set: {field: value}` and `reset: [field]`.
/// The address is refused by name (`url_from_zabbix`), a credential (`credential`) and the type
/// (`cluster_type`) too — each with where it is set instead — and anything else unknown.
pub fn parse_change(set: Option<&Value>, reset: Option<&Value>) -> Result<(BTreeMap<String, Value>, Vec<String>), Refusal> {
    let set = match set {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(refusal("bad_message", "set: an object of field → value")),
    };
    let reset: Vec<String> = match reset {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(|s| s.trim().to_string()).ok_or(()))
            .collect::<Result<_, _>>().map_err(|_| refusal("bad_message", "reset: a list of field names"))?,
        Some(_) => return Err(refusal("bad_message", "reset: a list of field names")),
    };
    let known = |k: &str| -> Result<(), Refusal> {
        let low = k.to_ascii_lowercase().replace(['_', '-'], "");
        if ADDRESS.contains(&low.as_str()) {
            return Err(refusal("url_from_zabbix", "the address always comes from Zabbix: change {$ELASTICSEARCH.HOST}, PORT or SCHEME on the host"));
        }
        if CREDENTIAL.contains(&low.as_str()) {
            return Err(refusal("credential", "a credential is not part of the overlay: an administrator types it in the Edit dialog (CREDENTIAL_SET), and it is kept encrypted on the server"));
        }
        if KIND.contains(&low.as_str()) {
            return Err(refusal("cluster_type", "the cluster type, ULM and SLM are set with CLUSTER_META_SET"));
        }
        if !FIELDS.contains(&k) {
            return Err(refusal("unknown_field", format!("{k}: not a field ElasticPro keeps for a Zabbix cluster")));
        }
        Ok(())
    };
    let mut out = BTreeMap::new();
    for (k, v) in &set {
        known(k)?;
        out.insert(k.clone(), check_field(k, v).map_err(|m| refusal("bad_request", m))?);
    }
    for k in &reset {
        known(k)?;
        if out.contains_key(k) {
            return Err(refusal("bad_message", format!("{k}: set and reset at once")));
        }
    }
    if out.is_empty() && reset.is_empty() {
        return Err(refusal("bad_message", "nothing to change: say what to set, or which field to reset"));
    }
    Ok((out, reset))
}

/* ------------------------------------ who may change what ------------------------------------ */

/// Whether a Zabbix cluster signs in with a credential of its own — one that belongs to this
/// cluster rather than to every cluster, so where it is sent is an administrator's decision: a
/// password read from Vault (`vault`), a password macro (`plain-macro`), one the module handed over
/// for this host (`core-secret`), one typed in ElasticPro (`elasticpro-own`), or, with ElasticPro's
/// credentials in use, a config cluster's own header for the same address (`per_address`). The
/// shared ones — the default (`core-default`), ElasticPro's shared credential — and none at all
/// are not. `credential` is the row's (`bridge::zabbix_build`). Unknown is treated as its own.
pub fn signs_in_with_own(credential: &str, per_address: bool) -> bool {
    match credential {
        "core-default" | "none" | "password-not-set" => false,
        "elasticpro" => per_address,
        _ => true,
    }
}

/// What a caller below admin may not change, or `None`: certificates set to `insecure` (any
/// credential would then go to whoever answers, whatever the cluster's), and — for a cluster that
/// signs in with a credential of its own — its route or certificate setting (`DESTINATION`), set
/// or reset: that credential would go where the operator points it. The same rule as a config
/// cluster's (`cluster_save::apply`).
pub fn below_admin_refusal(set: &BTreeMap<String, Value>, reset: &[String], own: bool) -> Option<Refusal> {
    if set.get("tls").and_then(Value::as_str) == Some("insecure") {
        return Some(refusal("tls_insecure", "only an administrator turns certificate checks off (tls: insecure)"));
    }
    let moves = DESTINATION.iter().any(|k| set.contains_key(*k) || reset.iter().any(|r| r == k));
    if own && moves {
        return Some(refusal("credential_destination",
            "this cluster signs in with a credential of its own (from Zabbix or kept in ElasticPro): only an administrator changes its route or certificate setting"));
    }
    None
}

/* -------------------------------- what the sync applies -------------------------------- */

/// The name the cluster goes by: the overlay's, else Zabbix's.
pub fn name(ov: Option<&Overlay>, zabbix: &str) -> String {
    ov.and_then(|o| o.text("name")).unwrap_or(zabbix).to_string()
}

/// The certificate setting: the overlay's, else none (the defaults' — as Zabbix sets none).
pub fn tls(ov: Option<&Overlay>) -> Option<String> {
    ov.and_then(|o| o.text("tls")).map(String::from)
}

/// Whether the cluster is polled. Only the overlay switches one off; Zabbix's own switch is the
/// host's status, which the sync's `host.get` already honours.
pub fn enabled(ov: Option<&Overlay>) -> bool {
    ov.and_then(|o| o.get("enabled")).and_then(Value::as_bool).unwrap_or(true)
}

/// The route: the overlay's when it sets one (`""` = direct), else Zabbix's (already matched
/// to one of ElasticPro's jump hosts). Returns the route, a note when the overlay names a jump
/// host ElasticPro does not have (then direct, as an unknown Zabbix jump host is), and whether
/// the overlay decided it — Zabbix's own notes about its jump host do not apply then.
pub fn route(ov: Option<&Overlay>, zabbix: Option<String>, jump_ids: &HashSet<String>) -> (Option<String>, Option<String>, bool) {
    match ov.and_then(|o| o.text("via")) {
        None => (zabbix, None, false),
        Some("") => (None, None, true),
        Some(j) if jump_ids.contains(j) => (Some(j.to_string()), None, true),
        Some(j) => (None, Some(format!("jump host {j:?}, set in ElasticPro, is not in ElasticPro's jump_hosts: reset the route or add the jump host")), true),
    }
}

/// The tags a Zabbix cluster has without an overlay: its client.
pub fn zabbix_tags(client: Option<&str>) -> Vec<String> {
    client.filter(|c| !c.trim().is_empty()).map(|c| vec![c.to_string()]).unwrap_or_default()
}

/// What the `ZABBIX_CLUSTERS` row carries about the overlay, merged into the row the sync built:
/// every field's effective value the pages read (`tags`, `note`, `liveRetention`, …, `tls`,
/// `enabled`), which fields are set in ElasticPro (`overridden`), Zabbix's own value for those
/// Zabbix has (`zabbixValues`), and who set them last. `name` and `via` are already the
/// effective ones in the row; Zabbix's are here so a page can offer them back.
pub fn row_fields(ov: Option<&Overlay>, zabbix_name: &str, zabbix_via: Option<&str>, client: Option<&str>) -> Map<String, Value> {
    let mut m = Map::new();
    let pick = |k: &str| ov.and_then(|o| o.get(k)).cloned();
    m.insert("tags".into(), pick("tags").unwrap_or_else(|| json!(zabbix_tags(client))));
    for k in ["note", "liveRetention", "snapshotRetention", "backupCapacity", "volumeWindowDays", "volumeTopDays", "volumeHeadroomPercent", "tls"] {
        m.insert(k.into(), pick(k).unwrap_or(Value::Null));
    }
    m.insert("enabled".into(), json!(enabled(ov)));
    m.insert("overridden".into(), json!(ov.map(|o| o.fields.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()));
    m.insert("zabbixValues".into(), json!({ "name": zabbix_name, "via": zabbix_via, "tags": zabbix_tags(client) }));
    if let Some(o) = ov.filter(|o| !o.fields.is_empty()) {
        m.insert("overriddenBy".into(), json!(o.set_by));
        m.insert("overriddenAt".into(), json!(o.set_at));
    }
    m
}

/* ------------------------------------------ the store ------------------------------------------ */

pub struct Overlays {
    path: Option<PathBuf>,
    map: RwLock<BTreeMap<String, Overlay>>,
}

impl Overlays {
    pub fn open(path: Option<PathBuf>) -> Overlays {
        let map = Self::read(path.as_ref());
        Overlays { path, map: RwLock::new(map) }
    }

    fn read(path: Option<&PathBuf>) -> BTreeMap<String, Overlay> {
        path.and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<BTreeMap<String, Overlay>>(&s)
                .map_err(|e| tracing::warn!("{FILE} is unreadable, no overlay applies until it is fixed: {e}")).ok())
            .unwrap_or_default()
    }

    /// Read the file again (the report worker, after the core changed it).
    pub fn reload(&self) {
        *self.map.write() = Self::read(self.path.as_ref());
    }

    pub fn get(&self, host_id: &str) -> Option<Overlay> {
        self.map.read().get(host_id).cloned()
    }

    pub fn all(&self) -> BTreeMap<String, Overlay> {
        self.map.read().clone()
    }

    fn save(&self, map: &BTreeMap<String, Overlay>) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension(format!("json.{}.tmp", crate::auth::random_hex(6)));
        {
            use std::io::Write as _;
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut f = o.open(&tmp).map_err(|e| format!("{FILE}.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{FILE}: {e}")
        })
    }

    /// Written before it is believed: a failed write changes nothing.
    fn commit(&self, next: BTreeMap<String, Overlay>) -> Result<(), String> {
        self.save(&next)?;
        *self.map.write() = next;
        Ok(())
    }

    /// Set some fields and reset others on one host's overlay (already checked: `parse_change`).
    /// An overlay left with no field is removed. `host` and `id` are the host's technical name
    /// and cluster id now (`seen_as`). Returns the overlay as it is kept, or `None` when none is left.
    pub fn change(&self, host_id: &str, seen_as: (&str, &str), set: BTreeMap<String, Value>, reset: &[String], by: &str, at: u64)
        -> Result<Option<Overlay>, String> {
        let (host, id) = seen_as;
        let host_id = host_id.trim();
        if host_id.is_empty() || host_id.len() > 64 {
            return Err("hostId must name a Zabbix host".into());
        }
        let mut next = self.map.read().clone();
        if !next.contains_key(host_id) && next.len() >= MAX_ENTRIES {
            return Err(format!("at most {MAX_ENTRIES} Zabbix clusters keep edits"));
        }
        let mut o = next.remove(host_id).unwrap_or_default();
        for k in reset {
            o.fields.remove(k);
        }
        o.fields.extend(set);
        o.set_by = by.to_string();
        o.set_at = at;
        o.host = host.to_string();
        o.last_id = id.to_string();
        let kept = (!o.fields.is_empty()).then(|| o.clone());
        if let Some(k) = &kept {
            next.insert(host_id.to_string(), k.clone());
        }
        self.commit(next)?;
        Ok(kept)
    }

    /// A sync saw this host with this id and technical name. Returns the id the overlay last
    /// knew when it differs (the technical name changed), after recording the new one. Hosts with
    /// no overlay are not added; nothing is ever removed here — an orphan waits for its host.
    pub fn seen(&self, host_id: &str, id: &str, host: &str) -> Result<Option<String>, String> {
        let before = match self.map.read().get(host_id) {
            None => return Ok(None),
            Some(o) if o.last_id == id && o.host == host => return Ok(None),
            Some(o) => o.last_id.clone(),
        };
        let mut next = self.map.read().clone();
        if let Some(o) = next.get_mut(host_id) {
            o.last_id = id.to_string();
            o.host = host.to_string();
        }
        self.commit(next)?;
        Ok((!before.is_empty() && before != id).then_some(before))
    }

    /// Host ids with an overlay that are not among `present`: kept, shown nowhere.
    pub fn orphans(&self, present: &HashSet<String>) -> Vec<String> {
        self.map.read().keys().filter(|k| !present.contains(*k)).cloned().collect()
    }

    /// A backup's restore: one host's overlay put back as it was, or (`None`) removed.
    pub fn put(&self, host_id: &str, o: Option<Overlay>) -> Result<(), String> {
        let mut next = self.map.read().clone();
        match o {
            Some(o) if !o.fields.is_empty() => {
                for (k, v) in &o.fields {
                    check_field(k, v)?;
                }
                if !next.contains_key(host_id) && next.len() >= MAX_ENTRIES {
                    return Err(format!("at most {MAX_ENTRIES} Zabbix clusters keep edits"));
                }
                next.insert(host_id.to_string(), o);
            }
            _ => {
                next.remove(host_id);
            }
        }
        self.commit(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster_secrets::{config_key, ClusterSecrets};

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("ep-overlay-{}", crate::auth::random_hex(6))).join(FILE)
    }

    fn set(v: Value) -> BTreeMap<String, Value> {
        parse_change(Some(&v), None).unwrap().0
    }

    #[test]
    fn the_overlay_is_applied_over_what_zabbix_says() {
        let jumps: HashSet<String> = ["jumpa".to_string()].into();
        let none = None;
        assert_eq!(name(none, "es-prod"), "es-prod");
        assert_eq!(route(none, Some("jumpz".into()), &jumps), (Some("jumpz".into()), None, false), "Zabbix's route stands");
        assert!(enabled(none));
        let o = Overlay { fields: set(json!({ "name": "Prod EU", "via": "jumpa", "tls": "System", "enabled": false,
                                              "tags": ["eu", "zabbix", "EU", "prod"], "liveRetention": "30d" })), ..Default::default() };
        assert_eq!(name(Some(&o), "es-prod"), "Prod EU");
        assert_eq!(route(Some(&o), None, &jumps), (Some("jumpa".into()), None, true));
        assert_eq!(tls(Some(&o)).as_deref(), Some("system"));
        assert!(!enabled(Some(&o)));
        let row = row_fields(Some(&o), "es-prod", None, Some("acme"));
        assert_eq!(row["tags"], json!(["eu", "prod"]), "de-duplicated, without the marker the page adds");
        assert_eq!(row["liveRetention"], json!("30d"));
        assert_eq!(row["note"], Value::Null, "not set is null, never a guess");
        assert_eq!(row["zabbixValues"], json!({ "name": "es-prod", "via": null, "tags": ["acme"] }));
        assert_eq!(row["overridden"], json!(["enabled", "liveRetention", "name", "tags", "tls", "via"]));
        // Direct on purpose, and a jump host ElasticPro does not have.
        let direct = Overlay { fields: set(json!({ "via": "" })), ..Default::default() };
        assert_eq!(route(Some(&direct), Some("jumpz".into()), &jumps), (None, None, true));
        let gone = Overlay { fields: set(json!({ "via": "nope" })), ..Default::default() };
        let (r, note, decided) = route(Some(&gone), Some("jumpa".into()), &jumps);
        assert_eq!((r, decided), (None, true));
        assert!(note.unwrap().contains("not in ElasticPro's jump_hosts"));
        // Without an overlay the row is Zabbix's: the client is the tag.
        let plain = row_fields(None, "es-prod", Some("jumpz"), Some("acme"));
        assert_eq!((plain["tags"].clone(), plain["enabled"].clone(), plain["overridden"].clone()), (json!(["acme"]), json!(true), json!([])));
        assert!(plain.get("overriddenBy").is_none());
    }

    #[test]
    fn the_address_a_credential_and_unknown_fields_are_refused() {
        for k in ["url", "URL", "address", "host", "port", "scheme"] {
            let r = parse_change(Some(&json!({ k: "https://elsewhere:9200" })), None).unwrap_err();
            assert_eq!(r.kind, "url_from_zabbix", "{k}");
            let r = parse_change(None, Some(&json!([k]))).unwrap_err();
            assert_eq!(r.kind, "url_from_zabbix", "a reset of {k} is refused too");
        }
        for k in ["username", "password", "apiKey", "bearer", "api_key"] {
            assert_eq!(parse_change(Some(&json!({ k: "x" })), None).unwrap_err().kind, "credential", "{k}");
        }
        assert_eq!(parse_change(Some(&json!({ "type": "ci" })), None).unwrap_err().kind, "cluster_type");
        assert_eq!(parse_change(Some(&json!({ "colour": "red" })), None).unwrap_err().kind, "unknown_field");
        assert_eq!(parse_change(None, None).unwrap_err().kind, "bad_message", "nothing to change");
        assert_eq!(parse_change(Some(&json!({ "name": "a" })), Some(&json!(["name"]))).unwrap_err().kind, "bad_message");
        for (k, v) in [("name", json!("")), ("name", json!("x".repeat(129))), ("tls", json!("maybe")), ("enabled", json!("yes")),
                       ("volumeWindowDays", json!(0)), ("volumeWindowDays", json!(91)), ("volumeHeadroomPercent", json!(201)),
                       ("volumeTopDays", json!(2.5)), ("liveRetention", json!("forever")), ("backupCapacity", json!("2TB; rm")),
                       ("via", json!("a b")), ("tags", json!("prod")), ("note", json!("   "))] {
            assert_eq!(parse_change(Some(&json!({ k: v })), None).unwrap_err().kind, "bad_request", "{k} = {v}");
        }
        let (s, r) = parse_change(Some(&json!({ "name": "  Prod  ", "volumeHeadroomPercent": 0, "backupCapacity": "2 TB" })), Some(&json!(["note"]))).unwrap();
        assert_eq!(s["name"], json!("Prod"));
        assert_eq!((s["volumeHeadroomPercent"].clone(), s["backupCapacity"].clone(), r), (json!(0), json!("2 TB"), vec!["note".to_string()]));
    }

    #[test]
    fn below_admin_the_route_of_a_cluster_with_its_own_credential_and_insecure_certificates_are_refused() {
        let via = set(json!({ "via": "" }));
        let tls = set(json!({ "tls": "system" }));
        let note = set(json!({ "note": "x" }));
        // Its own: Vault, a password macro, one handed over for the host, one kept in ElasticPro,
        // a config cluster's own header at the address.
        for (cred, per_address) in [("vault", false), ("plain-macro", false), ("core-secret", false), ("elasticpro-own", false),
                                    ("elasticpro", true), ("something-new", false)] {
            let own = signs_in_with_own(cred, per_address);
            assert!(own, "{cred}");
            for s in [&via, &tls] {
                assert_eq!(below_admin_refusal(s, &[], own).map(|r| r.kind), Some("credential_destination"), "{cred}: {s:?}");
            }
            assert_eq!(below_admin_refusal(&BTreeMap::new(), &["via".into()], own).map(|r| r.kind), Some("credential_destination"), "a reset moves it too");
            assert!(below_admin_refusal(&note, &["note".into()], own).is_none(), "{cred}: everything else stays the operator's");
        }
        // Shared or none: the route may change.
        for (cred, per_address) in [("core-default", false), ("elasticpro", false), ("none", false), ("password-not-set", false)] {
            let own = signs_in_with_own(cred, per_address);
            assert!(!own, "{cred}");
            assert!(below_admin_refusal(&via, &[], own).is_none(), "{cred}");
            assert!(below_admin_refusal(&tls, &[], own).is_none(), "{cred}");
        }
        // Insecure certificates: never below admin, whatever the credential.
        let insecure = set(json!({ "tls": "insecure" }));
        for own in [false, true] {
            assert_eq!(below_admin_refusal(&insecure, &[], own).map(|r| r.kind), Some("tls_insecure"));
        }
    }

    #[test]
    fn an_overlay_survives_syncs_and_restarts_and_a_reset_removes_one_field() {
        let p = tmp();
        let s = Overlays::open(Some(p.clone()));
        let kept = s.change("10101", ("es-prod", "zbx-es-prod"), set(json!({ "name": "Prod EU", "note": "on call: team A", "via": "" })), &[], "sara", 5).unwrap().unwrap();
        assert_eq!(kept.fields.len(), 3);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A sync: Zabbix renamed the host's visible name; the overlay's name still wins.
        assert_eq!(s.seen("10101", "zbx-es-prod", "es-prod").unwrap(), None, "nothing new: not written");
        assert_eq!(name(s.get("10101").as_ref(), "es-prod-renamed-in-zabbix"), "Prod EU");
        // A restart.
        let again = Overlays::open(Some(p.clone()));
        assert_eq!(again.get("10101"), Some(kept));
        // "Use Zabbix's value" for the name only.
        let after = again.change("10101", ("es-prod", "zbx-es-prod"), BTreeMap::new(), &["name".into()], "otto", 9).unwrap().unwrap();
        assert_eq!(after.fields.keys().cloned().collect::<Vec<_>>(), vec!["note", "via"]);
        assert_eq!(name(Some(&after), "es-prod-renamed-in-zabbix"), "es-prod-renamed-in-zabbix", "Zabbix's name again");
        assert_eq!(after.set_by, "otto");
        // The last fields reset: no overlay left, on disk too.
        assert_eq!(again.change("10101", ("es-prod", "zbx-es-prod"), BTreeMap::new(), &["note".into(), "via".into()], "otto", 10).unwrap(), None);
        assert!(Overlays::open(Some(p.clone())).get("10101").is_none());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn an_orphan_is_kept_until_its_host_returns() {
        let p = tmp();
        let s = Overlays::open(Some(p.clone()));
        s.change("1", ("a", "zbx-a"), set(json!({ "name": "A" })), &[], "sara", 1).unwrap();
        s.change("2", ("b", "zbx-b"), set(json!({ "name": "B" })), &[], "sara", 1).unwrap();
        // Host 2 is gone from Zabbix: nothing removes it.
        let present: HashSet<String> = ["1".to_string()].into();
        assert_eq!(s.orphans(&present), vec!["2"]);
        s.seen("1", "zbx-a", "a").unwrap();
        assert!(Overlays::open(Some(p.clone())).get("2").is_some(), "kept on disk");
        // Back, under a new technical name: the overlay applies, and says which id it had.
        assert_eq!(s.seen("2", "zbx-b2", "b2").unwrap(), Some("zbx-b".to_string()));
        assert_eq!(s.get("2").unwrap().last_id, "zbx-b2");
        assert_eq!(name(s.get("2").as_ref(), "b2"), "B");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn a_cluster_s_own_credential_is_bound_to_the_address_zabbix_gives() {
        // The core keeps a Zabbix cluster's own credential as a config cluster's: `cfg:<id>`,
        // bound to `destination_of(url from Zabbix, route, certificate setting)`.
        let secrets = ClusterSecrets::in_memory();
        let key = config_key("zbx-es-prod");
        let here = crate::bridge::destination_of("http://10.0.0.1:9200", None, None);
        secrets.set_bound(&key, "svc", "pw-1", &here, "sara", 1).unwrap();
        assert!(secrets.header_at(&key, &here).is_some(), "used at the address it was typed for");
        // Zabbix moves the cluster: the URL is never the overlay's, so the credential stays behind.
        let moved = crate::bridge::destination_of("http://10.9.9.9:9200", None, None);
        assert!(secrets.header_at(&key, &moved).is_none(), "never sent to another address");
        // The overlay's route is part of the destination too.
        let via = crate::bridge::destination_of("http://10.0.0.1:9200", Some("jumpa"), None);
        assert!(secrets.header_at(&key, &via).is_none());
    }
}
