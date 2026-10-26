//! `CLUSTER_SAVE`: one cluster added or changed in the config file by an operator.
//!
//! An admin edits the whole file (`CONFIG_WRITE`): credentials, defaults, jump hosts,
//! removals. An operator may add a cluster, change one, or switch it off — and nothing
//! else. This module is the rule, as a pure function over the parsed file, so the test
//! can hold it to the letter without a disk:
//!
//! * only `clusters[]` (or `hosts[]`) changes, and only the one entry named;
//! * nothing is removed: the list is one longer or the same length afterwards;
//! * no credential goes in — a key `redact_config` would take out (`password`, `apiKey`,
//!   `username`, …), a sealed `enc:v1:` value or `user:pass@` in the URL is refused, not
//!   dropped, so the operator learns the rule rather than losing a field quietly;
//! * the credential already on the entry stays exactly as it was: the operator never saw
//!   it (`CONFIG_VIEW` strips it) and cannot have meant to change it;
//! * a `via:` must name a jump host the file has — `normalize()` in the UI throws on an
//!   unknown one, which would break the config for everybody, not just this cluster;
//! * names are unique by their id (`slug`), not only by their spelling: "Alpha" and
//!   "alpha" would be one cluster to the fleet, and an add under the second would take
//!   over the first's polled entry;
//! * a cluster that signs in with a credential of its own keeps its destination — the
//!   address, the route (`via`) and the certificate setting (`tls`): the next admin PRIME
//!   builds a header from the file and would send that credential wherever, and however,
//!   the entry now points. An administrator moves such a cluster; an operator moves one
//!   that uses the shared credential, and may change everything else about either.
//!
//! Which clusters a scoped caller may touch is the caller's business (`sees`); this takes
//! the predicate. `apply_automations` is the same door for the `automations:` list.

use crate::bridge::redact_config;
use serde_json::{json, Map, Value};

/// Why a save was refused: a kind the UI can switch on, and a sentence for the person.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub kind: &'static str,
    pub message: String,
}

impl Refusal {
    fn new(kind: &'static str, message: impl Into<String>) -> Refusal {
        Refusal { kind, message: message.into() }
    }
    pub fn to_json(&self) -> Value {
        json!({ "ok": false, "kind": self.kind, "message": self.message })
    }
}

/// What a successful save did, for the reply and the audit line.
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    /// `added` or `edited`.
    pub action: &'static str,
    /// The cluster's name after the save.
    pub name: String,
    /// The name it had before (an edit), which may differ from `name`.
    pub was: Option<String>,
    /// The entry as it is in the file now — credentials included, so the caller can prime
    /// with them. Never sent back to the operator as is.
    pub entry: Value,
    /// The entry before the save, when there was one.
    pub before: Option<Value>,
}

/// Keys the server sets on a `CONFIG_VIEW` entry that have no place in the file.
const VIEW_ONLY: &[&str] = &["_index", "_id"];

const MAX_NAME: usize = 128;

/// The key the cluster list is under: `clusters`, or `hosts` in an older file. A file with
/// neither gets `clusters`.
fn list_key(raw: &Value) -> &'static str {
    if raw.get("clusters").is_some() || raw.get("hosts").is_none() { "clusters" } else { "hosts" }
}

/// The ids the file's jump hosts go by, whichever spelling and shape the file uses.
fn jump_ids(raw: &Value) -> Vec<String> {
    let mut out = vec![];
    for k in ["jump_hosts", "jumpHosts", "jumps"] {
        match raw.get(k) {
            Some(Value::Object(m)) => out.extend(m.keys().cloned()),
            Some(Value::Array(a)) => out.extend(a.iter().enumerate().map(|(i, j)| {
                j.get("id").or_else(|| j.get("name")).and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| format!("jump{}", i + 1))
            })),
            _ => {}
        }
    }
    out
}

fn name_of(c: &Value) -> Option<&str> {
    c.get("name").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// The id the fleet knows a config cluster by: the UI's `slug()` (core/config.js), so the
/// core's poller and the page agree. A name with nothing usable in it is "cluster".
pub fn cluster_id(name: &str) -> String {
    let s = crate::zabbix_api::slug(name);
    if s.is_empty() { "cluster".to_string() } else { s }
}

/// An address with its credential and trailing slash taken out, lower-cased for the
/// host: what "the same address" means here.
fn address_key(url: &str) -> String {
    let mut v = json!(url.trim().trim_end_matches('/'));
    redact_config(&mut v);
    v.as_str().unwrap_or("").to_ascii_lowercase()
}

/// The jump host an entry routes through, whichever key spells it; "" for direct.
pub fn route_of(c: &Value) -> String {
    ["via", "jump", "jumpHost", "jump_host"].iter()
        .find_map(|k| c.get(*k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or("").to_string()
}

/// Where and how a credential would be sent for this entry: address, route, certificate
/// setting. Equal destinations may hold the same credential.
pub fn destination(c: &Value) -> (String, String, String) {
    (address_key(c.get("url").and_then(|v| v.as_str()).unwrap_or("")),
     route_of(c),
     c.get("tls").and_then(|v| v.as_str()).map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default())
}

/// Whether a key is one `redact_config` takes out of a view — a credential's name.
fn is_secret_key(k: &str) -> bool {
    let mut probe = json!({ k: "x" });
    redact_config(&mut probe);
    probe.as_object().is_some_and(|m| m.is_empty())
}

/// Check what the operator sent and return it clean, or say what is wrong with it.
fn validate(incoming: &Value, raw: &Value) -> Result<Map<String, Value>, Refusal> {
    let Some(obj) = incoming.as_object() else {
        return Err(Refusal::new("bad_message", "the cluster must be an object"));
    };
    let mut c: Map<String, Value> = obj.iter().filter(|(k, _)| !VIEW_ONLY.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    // A credential of any kind: refused, never dropped. The probe is what CONFIG_VIEW would
    // have shown of this entry; if that differs from the entry, something secret is in it.
    let mut probe = Value::Object(c.clone());
    redact_config(&mut probe);
    if probe != Value::Object(c.clone()) {
        return Err(Refusal::new("credential_refused",
            "credentials are an administrator's: this save may not carry a username, password, API key, token or a sealed value, nor user:pass@ in the URL"));
    }
    let name = match c.get("name").and_then(|v| v.as_str()).map(str::trim) {
        Some("") => return Err(Refusal::new("bad_message", "give the cluster a name")),
        Some(n) if n.len() <= MAX_NAME && !n.chars().any(char::is_control) => n.to_string(),
        _ => return Err(Refusal::new("bad_message", format!("the name must be 1–{MAX_NAME} characters with no control characters"))),
    };
    c.insert("name".into(), json!(name));
    let url = c.get("url").and_then(|v| v.as_str()).map(|s| s.trim().trim_end_matches('/').to_string()).unwrap_or_default();
    let host_ok = url.split_once("://").is_some_and(|(scheme, rest)| {
        matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
            && rest.split('/').next().is_some_and(|h| !h.is_empty() && !h.chars().any(|ch| ch.is_whitespace() || ch.is_control()))
    });
    if !host_ok {
        return Err(Refusal::new("bad_message", "the URL must start with http:// or https:// and name a host"));
    }
    c.insert("url".into(), json!(url));
    for k in ["via", "jump", "jumpHost", "jump_host"] {
        if let Some(v) = c.get(k) {
            let Some(id) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                c.remove(k);
                continue;
            };
            if !jump_ids(raw).iter().any(|j| j == id) {
                return Err(Refusal::new("bad_message", format!("via: {id} is not a jump host in this config — an administrator adds jump hosts")));
            }
        }
    }
    // `enabled` is a yes or a no; "false" as a string would read as on in the UI.
    if let Some(e) = c.get("enabled") {
        if !e.is_boolean() {
            return Err(Refusal::new("bad_message", "enabled must be true or false"));
        }
        if e == &json!(true) {
            c.remove("enabled");
        }
    }
    Ok(c)
}

/// The credential-carrying keys and values of `old`, to be laid back over a new entry.
fn credential_parts(old: &Value) -> Map<String, Value> {
    old.as_object().map(|m| {
        m.iter().filter(|(k, v)| is_secret_key(k) || matches!(v, Value::String(s) if s.starts_with("enc:v1:")))
            .map(|(k, v)| (k.clone(), v.clone())).collect()
    }).unwrap_or_default()
}

/// Apply one operator's save to the parsed config.
///
/// `replace` names the cluster being edited (its name before the edit); `None` adds one.
/// `sees` is the caller's scope: an entry it does not see is, to this caller, not there.
pub fn apply(raw: &mut Value, incoming: &Value, replace: Option<&str>, sees: &dyn Fn(&Value) -> bool) -> Result<Saved, Refusal> {
    if !raw.is_object() {
        return Err(Refusal::new("parse_error", "the config file is not a mapping"));
    }
    let clean = validate(incoming, raw)?;
    let name = clean["name"].as_str().unwrap_or_default().to_string();
    let key = list_key(raw);
    if raw.get(key).is_none() {
        raw[key] = json!([]);
    }
    let Some(list) = raw.get_mut(key).and_then(Value::as_array_mut) else {
        return Err(Refusal::new("parse_error", format!("{key}: is not a list in this config")));
    };
    let before_len = list.len();
    let pos = match replace {
        Some(was) => {
            let was = was.trim();
            let Some(i) = list.iter().position(|c| name_of(c) == Some(was) && sees(c)) else {
                return Err(Refusal::new("not_found", format!("no cluster called {was:?} in the config — it may have been renamed or removed meanwhile")));
            };
            Some(i)
        }
        None => None,
    };
    let id = cluster_id(&name);
    if let Some((_, other)) = list.iter().enumerate().find(|(i, c)| Some(*i) != pos && name_of(c).is_some_and(|n| n == name || cluster_id(n) == id)) {
        let other_name = name_of(other).unwrap_or_default();
        // A cluster this caller may not see is not named to them; the id they chose is.
        return Err(Refusal::new("name_taken", if other_name == name {
            format!("another cluster is already called {name:?}")
        } else if sees(other) {
            format!("{name:?} would be the same cluster as {other_name:?} to the fleet (both are {id:?}) — choose a name that differs in more than case or punctuation")
        } else {
            format!("another cluster already goes by {id:?} — choose a name that differs in more than case or punctuation")
        }));
    }
    let mut entry = clean;
    let (action, was, before) = match pos {
        Some(i) => {
            let old = list[i].clone();
            if !credential_parts(&old).is_empty() && destination(&old) != destination(&Value::Object(entry.clone())) {
                return Err(Refusal::new("credential_refused",
                    "this cluster signs in with a credential of its own, so only an administrator changes its address, its route or its certificate setting — everything else about it you may change"));
            }
            // The credential the operator never saw, exactly as it was. A URL that carried
            // one (`user:pass@`) is kept whole when the operator sent its redacted form.
            for (k, v) in credential_parts(&old) {
                entry.insert(k, v);
            }
            if let Some(old_url) = old.get("url").and_then(|v| v.as_str()) {
                if address_key(old_url) == address_key(entry.get("url").and_then(|v| v.as_str()).unwrap_or("")) {
                    entry.insert("url".into(), json!(old_url));
                }
            }
            let was = name_of(&old).map(String::from);
            list[i] = Value::Object(entry);
            ("edited", was, Some(old))
        }
        None => {
            list.push(Value::Object(entry));
            ("added", None, None)
        }
    };
    let after_len = list.len();
    debug_assert_eq!(after_len, before_len + usize::from(pos.is_none()), "a save never removes a cluster");
    let entry = list[pos.unwrap_or(after_len - 1)].clone();
    Ok(Saved { action, name, was, entry, before })
}

/// The most automations a config holds, and the longest a rule's JSON may be.
pub const MAX_AUTOMATIONS: usize = 200;
pub const MAX_RULE_BYTES: usize = 16 * 1024;

/// `AUTOMATIONS_SAVE`: the `automations:` list replaced, and nothing else. Automations
/// are an operator's work (they propose, an admin still acts); the rules are plain data —
/// a name, a pattern, an action — so the same credential probe applies to each, and the
/// list is bounded. Returns how many rules the file holds now.
pub fn apply_automations(raw: &mut Value, incoming: &Value) -> Result<usize, Refusal> {
    if !raw.is_object() {
        return Err(Refusal::new("parse_error", "the config file is not a mapping"));
    }
    let Some(list) = incoming.as_array() else {
        return Err(Refusal::new("bad_message", "automations must be a list"));
    };
    if list.len() > MAX_AUTOMATIONS {
        return Err(Refusal::new("bad_message", format!("at most {MAX_AUTOMATIONS} automations")));
    }
    let mut ids = std::collections::HashSet::new();
    for r in list {
        let Some(m) = r.as_object() else { return Err(Refusal::new("bad_message", "every automation must be an object")) };
        let id = m.get("id").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
        if id.is_empty() || id.len() > MAX_NAME || !ids.insert(id.to_string()) {
            return Err(Refusal::new("bad_message", "every automation needs its own id"));
        }
        if r.to_string().len() > MAX_RULE_BYTES {
            return Err(Refusal::new("bad_message", format!("an automation is over {MAX_RULE_BYTES} bytes")));
        }
        let mut probe = r.clone();
        redact_config(&mut probe);
        if probe != *r {
            return Err(Refusal::new("credential_refused", "an automation may not carry a credential"));
        }
    }
    raw["automations"] = Value::Array(list.clone());
    Ok(list.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Value {
        json!({
            "version": 2,
            "credentials": { "username": "fleet", "password": "fleet-pw" },
            "jump_hosts": { "jumpa": { "host": "jump-a", "user": "ops" } },
            "clusters": [
                { "name": "Alpha", "url": "https://svc:pw@alpha:9200", "via": "jumpa", "username": "alpha-svc", "apiKey": "alpha-key", "tags": ["prod"] },
                { "name": "Beta", "url": "https://beta:9200", "password": "enc:v1:sealed", "zabbixGroups": ["ES beta"] }
            ]
        })
    }
    const ALL: &dyn Fn(&Value) -> bool = &|_| true;

    #[test]
    fn adding_a_cluster_appends_it_without_a_credential() {
        let mut raw = cfg();
        let s = apply(&mut raw, &json!({ "name": "Gamma", "url": "https://gamma:9200/", "_index": 7, "note": "new" }), None, ALL).unwrap();
        assert_eq!((s.action, s.name.as_str(), s.was.clone()), ("added", "Gamma", None));
        let list = raw["clusters"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[2], json!({ "name": "Gamma", "url": "https://gamma:9200", "note": "new" }), "trailing slash and _index gone");
        assert_eq!(raw["credentials"]["password"], json!("fleet-pw"), "nothing outside clusters[] moved");
    }

    #[test]
    fn editing_keeps_the_credential_the_operator_never_saw() {
        let mut raw = cfg();
        // What CONFIG_VIEW showed of Alpha, with the tags changed and the note dropped.
        let s = apply(&mut raw, &json!({ "name": "Alpha", "url": "https://alpha:9200", "via": "jumpa", "_index": 0, "liveRetention": "30d" }), Some("Alpha"), ALL).unwrap();
        assert_eq!((s.action, s.was.as_deref()), ("edited", Some("Alpha")));
        let a = &raw["clusters"][0];
        assert_eq!(a["username"], json!("alpha-svc"));
        assert_eq!(a["apiKey"], json!("alpha-key"));
        assert_eq!(a["url"], json!("https://svc:pw@alpha:9200"), "the URL's user:pass@ comes back");
        assert_eq!(a["liveRetention"], json!("30d"));
        assert!(a.get("tags").is_none(), "the field the operator removed is gone");
        assert_eq!(raw["clusters"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_cluster_with_its_own_credential_keeps_its_address() {
        let mut raw = cfg();
        let r = apply(&mut raw, &json!({ "name": "Alpha", "url": "https://alpha-new:9200" }), Some("Alpha"), ALL).unwrap_err();
        assert_eq!(r.kind, "credential_refused");
        assert_eq!(raw, cfg(), "nothing moved");
        // Spelled differently, the same address: not a move.
        apply(&mut raw, &json!({ "name": "Alpha", "url": "HTTPS://alpha:9200/", "via": "jumpa" }), Some("Alpha"), ALL).unwrap();
        assert_eq!(raw["clusters"][0]["url"], json!("https://svc:pw@alpha:9200"), "and the URL's credential comes back");
        // Nor its route or its certificate setting: both decide where and how the credential travels.
        for moved in [json!({ "name": "Alpha", "url": "https://alpha:9200" }),                      // via dropped
                      json!({ "name": "Alpha", "url": "https://alpha:9200", "jump": "jumpa", "tls": "insecure" })] {
            let mut raw = cfg();
            assert_eq!(apply(&mut raw, &moved, Some("Alpha"), ALL).unwrap_err().kind, "credential_refused", "{moved}");
        }
        let mut raw = cfg();
        apply(&mut raw, &json!({ "name": "Alpha", "url": "https://alpha:9200", "jump": "jumpa", "note": "same route, other key" }), Some("Alpha"), ALL).unwrap();
        assert_eq!(raw["clusters"][0]["note"], json!("same route, other key"));
        // A cluster on the shared credential moves freely.
        let mut raw = cfg();
        raw["clusters"][1] = json!({ "name": "Beta", "url": "https://beta:9200" });
        apply(&mut raw, &json!({ "name": "Beta", "url": "https://beta-new:9200", "via": "jumpa", "tls": "insecure" }), Some("Beta"), ALL).unwrap();
        assert_eq!(raw["clusters"][1]["url"], json!("https://beta-new:9200"));
    }

    #[test]
    fn a_name_that_is_another_clusters_id_is_taken() {
        let mut raw = cfg();
        for name in ["alpha", "ALPHA", "Alpha!", " alpha "] {
            let r = apply(&mut raw, &json!({ "name": name, "url": "https://x:9200" }), None, ALL).unwrap_err();
            assert_eq!(r.kind, "name_taken", "{name:?}");
            assert!(r.message.contains("same cluster"), "{}", r.message);
        }
        let r = apply(&mut raw, &json!({ "name": "beta", "url": "https://x:9200" }), Some("Alpha"), ALL).unwrap_err();
        assert_eq!(r.kind, "name_taken", "a rename onto another's id");
        assert_eq!(raw, cfg());
        assert_eq!(cluster_id("Alpha Prod (EU)"), "alpha-prod-eu");
        assert_eq!(cluster_id("!!!"), "cluster");
    }

    #[test]
    fn renaming_and_disabling_are_edits() {
        let mut raw = cfg();
        let s = apply(&mut raw, &json!({ "name": "Beta-2", "url": "https://beta:9200", "enabled": false }), Some("Beta"), ALL).unwrap();
        assert_eq!((s.name.as_str(), s.was.as_deref()), ("Beta-2", Some("Beta")));
        assert_eq!(raw["clusters"][1]["enabled"], json!(false));
        assert_eq!(raw["clusters"][1]["password"], json!("enc:v1:sealed"), "a sealed value is kept");
        let mut raw = cfg();
        apply(&mut raw, &json!({ "name": "Beta", "url": "https://beta:9200", "enabled": true }), Some("Beta"), ALL).unwrap();
        assert!(raw["clusters"][1].get("enabled").is_none(), "enabled: true is the default and is not written");
    }

    #[test]
    fn every_kind_of_credential_is_refused_not_dropped() {
        for bad in [
            json!({ "name": "X", "url": "https://x:9200", "username": "u" }),
            json!({ "name": "X", "url": "https://x:9200", "password": "p" }),
            json!({ "name": "X", "url": "https://x:9200", "apiKey": "k" }),
            json!({ "name": "X", "url": "https://x:9200", "Bearer": "t" }),
            json!({ "name": "X", "url": "https://x:9200", "s3": { "auth": { "secretAccessKey": "s" } } }),
            json!({ "name": "X", "url": "https://x:9200", "note": "enc:v1:sealed" }),
            json!({ "name": "X", "url": "https://u:p@x:9200" }),
        ] {
            let mut raw = cfg();
            let r = apply(&mut raw, &bad, None, ALL).unwrap_err();
            assert_eq!(r.kind, "credential_refused", "{bad}");
            assert_eq!(raw, cfg(), "nothing changed: {bad}");
        }
    }

    #[test]
    fn nothing_is_ever_removed_and_names_stay_unique() {
        let mut raw = cfg();
        let r = apply(&mut raw, &json!({ "name": "Beta", "url": "https://x:9200" }), None, ALL).unwrap_err();
        assert_eq!(r.kind, "name_taken");
        let r = apply(&mut raw, &json!({ "name": "Beta", "url": "https://x:9200" }), Some("Alpha"), ALL).unwrap_err();
        assert_eq!(r.kind, "name_taken", "renaming onto another cluster's name");
        let r = apply(&mut raw, &json!({ "name": "Zeta", "url": "https://x:9200" }), Some("Nope"), ALL).unwrap_err();
        assert_eq!(r.kind, "not_found");
        assert_eq!(raw, cfg());
    }

    #[test]
    fn a_scoped_caller_cannot_edit_what_it_does_not_see() {
        let mut raw = cfg();
        let only_beta: &dyn Fn(&Value) -> bool = &|c| c["name"] == json!("Beta");
        let r = apply(&mut raw, &json!({ "name": "Alpha", "url": "https://alpha:9200" }), Some("Alpha"), only_beta).unwrap_err();
        assert_eq!(r.kind, "not_found");
        assert!(apply(&mut raw, &json!({ "name": "Beta", "url": "https://beta:9200" }), Some("Beta"), only_beta).is_ok());
        // Nor learn its name from a collision.
        let r = apply(&mut raw, &json!({ "name": "alpha", "url": "https://x:9200" }), None, only_beta).unwrap_err();
        assert_eq!(r.kind, "name_taken");
        assert!(!r.message.contains("Alpha") && r.message.contains("\"alpha\""), "{}", r.message);
    }

    #[test]
    fn the_shape_of_the_entry_is_checked() {
        let mut raw = cfg();
        for (bad, why) in [
            (json!({ "url": "https://x:9200" }), "no name"),
            (json!({ "name": "  ", "url": "https://x:9200" }), "blank name"),
            (json!({ "name": "X", "url": "x:9200" }), "no scheme"),
            (json!({ "name": "X", "url": "ftp://x:9200" }), "wrong scheme"),
            (json!({ "name": "X", "url": "https://" }), "no host"),
            (json!({ "name": "X", "url": "https://x:9200", "via": "nowhere" }), "unknown jump host"),
            (json!({ "name": "X", "url": "https://x:9200", "enabled": "no" }), "enabled as text"),
            (json!("X"), "not an object"),
        ] {
            let r = apply(&mut raw, &bad, None, ALL).unwrap_err();
            assert_eq!(r.kind, "bad_message", "{why}");
        }
        assert_eq!(raw, cfg());
    }

    #[test]
    fn automations_replace_the_list_and_nothing_else() {
        let mut raw = cfg();
        let rules = json!([{ "id": "r1", "name": "old indices", "action": "delete", "pattern": "logs-*" }]);
        assert_eq!(apply_automations(&mut raw, &rules), Ok(1));
        assert_eq!(raw["automations"], rules);
        assert_eq!(raw["clusters"], cfg()["clusters"]);
        assert_eq!(apply_automations(&mut raw, &json!([])), Ok(0));
        for (bad, kind) in [
            (json!({}), "bad_message"),
            (json!([{ "name": "no id" }]), "bad_message"),
            (json!([{ "id": "a" }, { "id": "a" }]), "bad_message"),
            (json!([{ "id": "a", "password": "p" }]), "credential_refused"),
            (json!([{ "id": "a", "note": "enc:v1:x" }]), "credential_refused"),
        ] {
            assert_eq!(apply_automations(&mut raw, &bad).unwrap_err().kind, kind, "{bad}");
        }
        assert_eq!(raw["automations"], json!([]), "a refused save changes nothing");
    }

    #[test]
    fn an_older_file_with_hosts_and_no_jump_hosts_works_too() {
        let mut raw = json!({ "hosts": [{ "name": "Old", "url": "https://old:9200" }] });
        apply(&mut raw, &json!({ "name": "New", "url": "https://new:9200" }), None, ALL).unwrap();
        assert_eq!(raw["hosts"].as_array().unwrap().len(), 2);
        assert!(raw.get("clusters").is_none());
        let mut raw = json!({ "defaults": {} });
        apply(&mut raw, &json!({ "name": "First", "url": "https://first:9200" }), None, ALL).unwrap();
        assert_eq!(raw["clusters"][0]["name"], json!("First"));
    }
}
