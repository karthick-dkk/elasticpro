//! Backup and restore of everything ElasticPro knows about the clusters (docs/HANDBOOK.md,
//! "Backup and restore — the message contract").
//!
//! A backup is one JSON file, `.epbak`, holding the **sections** an admin ticked: each section
//! is a map of named items, so a restore can say per item whether it would be added, changed or
//! is only here now — and so the same code compares, merges and replaces every section. The
//! sections are collected from the stores that own them (`core.rs`); this file is the format,
//! the arithmetic and the rules, with no store and no clock of its own.
//!
//! **Credentials never travel in the clear.** Every secret the sections hold (cluster
//! passwords and API keys, the shared credential, the SMTP password, the history store's
//! secret, uploaded jump-host keys) is pulled out of the section into one credentials blob,
//! which is either left out or sealed: with a backup password the admin typed (`crypto::seal`:
//! PBKDF2-HMAC-SHA512, 600 000 rounds, AES-256-GCM — the same sealing as the config master
//! password) or, for a backup that stays on this server (scheduled, before a restore), under
//! the server's own key (`crypto::seal_with_key`, the key of `cluster-secrets.json`). The
//! sealed text carries the digest of the sections it belongs to, so a credentials blob cannot
//! be spliced onto another backup. **Never in a backup**: the Zabbix API token, the Zabbix
//! pairing secret and the display links' secrets — a restored server pairs and issues again.
//!
//! The file is `{format, formatVersion, coreVersion, takenAt, takenBy, kind, sections,
//! credentials?, digest}`; `digest` is SHA-256 over the canonical `sections`, so a damaged or
//! edited file is refused before anything reads it. A file from a newer format is refused.

pub mod core;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const FORMAT: &str = "elasticpro-backup";
pub const FORMAT_VERSION: u32 = 1;
/// Where kept backups live, under the data directory. Files 0600, the directory 0700.
pub const DIR: &str = "backups";
pub const EXT: &str = ".epbak";
pub const NAME_PREFIX: &str = "elasticpro-backup-";
/// The schedule, inside `DIR`.
pub const SCHEDULE_FILE: &str = "schedule.json";
pub const MIN_PASSWORD: usize = 12;
pub const DEFAULT_AT: &str = "02:00";
pub const DEFAULT_KEEP: usize = 14;
pub const MIN_KEEP: usize = 1;
pub const MAX_KEEP: usize = 90;
/// A file above this is refused unread: the message API carries a backup as text.
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

/* ------------------------------------- sections ------------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    /// Clusters and their settings (config `clusters`, the shared credential, cluster type and ULM).
    Clusters,
    /// Jump hosts, pinned host keys and certificates, uploaded jump-host keys.
    Trust,
    /// Alert triggers and automation rules.
    Alerts,
    /// Request policy and Defaults.
    Requests,
    /// Zabbix connection (never the token), role mapping, roles set by hand.
    Zabbix,
    /// Reports: indices and volume fields, mail delivery, report schedules, plan templates.
    Reports,
    /// Play: displays' settings, watch rules, exclusions.
    Play,
    /// History store and scheduled log delay settings.
    Data,
    /// Earlier config versions.
    Versions,
}

impl Section {
    pub const ALL: [Section; 9] = [
        Section::Clusters, Section::Trust, Section::Alerts, Section::Requests, Section::Zabbix,
        Section::Reports, Section::Play, Section::Data, Section::Versions,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Section::Clusters => "clusters",
            Section::Trust => "trust",
            Section::Alerts => "alerts",
            Section::Requests => "requests",
            Section::Zabbix => "zabbix",
            Section::Reports => "reports",
            Section::Play => "play",
            Section::Data => "data",
            Section::Versions => "versions",
        }
    }

    /// The name a person knows the section by — the one definition; the UI helper
    /// (`ui/js/core/backup-rules.js`) carries the same table and its test compares them.
    pub fn label(self) -> &'static str {
        match self {
            Section::Clusters => "Clusters and their settings",
            Section::Trust => "Jump hosts, pinned host keys and certificates",
            Section::Alerts => "Alert triggers and Automation rules",
            Section::Requests => "Request policy and Defaults",
            Section::Zabbix => "Zabbix connection, role mapping, roles set by hand",
            Section::Reports => "Reports: indices, volume fields, mail, plan templates",
            Section::Play => "Play: displays, watch rules, exclusions",
            Section::Data => "History store and scheduled log delay settings",
            Section::Versions => "Earlier config versions",
        }
    }

    pub fn parse(s: &str) -> Option<Section> {
        Section::ALL.into_iter().find(|x| x.id() == s.trim())
    }

    /// Whether a Replace removes an item of this section that the backup lacks. The one rule
    /// the preview counts by and the restore acts by: records in a list (clusters, jump hosts,
    /// pins, keys, triggers, rules, templates, displays, pinned roles) and the blocks a Replace
    /// clears (the shared credential, Zabbix options and role map, `defaults.volume`, Play's
    /// exclusions) go; a block a Replace only overwrites when the backup brings one (the request
    /// policy, Defaults, the Zabbix link, mail, report schedules, watch rules, the history store,
    /// the delay sink, config versions) stays.
    pub fn replace_removes(self, key: &str) -> bool {
        match self {
            Section::Clusters | Section::Trust | Section::Alerts => true,
            Section::Requests | Section::Data | Section::Versions => false,
            Section::Zabbix => key.starts_with("role:") || key == "options" || key == "roleMap",
            Section::Reports => key.starts_with("template:") || key == "volume",
            Section::Play => key.starts_with("display:") || key == "exclude",
        }
    }

    /// The sections named in a message (`sections: [...]`), or every section when it names none.
    pub fn from_message(v: Option<&Value>) -> Result<Vec<Section>, String> {
        let Some(list) = v.and_then(Value::as_array) else { return Ok(Section::ALL.to_vec()) };
        let mut out = vec![];
        for s in list {
            let id = s.as_str().ok_or("sections: a list of section ids")?;
            let sec = Section::parse(id).ok_or_else(|| format!("sections: {id:?} is not a section"))?;
            if !out.contains(&sec) {
                out.push(sec);
            }
        }
        if out.is_empty() {
            return Err("sections: tick at least one".into());
        }
        out.sort();
        Ok(out)
    }
}

/// Why a backup was taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Manual,
    Scheduled,
    BeforeRestore,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Kind::Manual => "manual",
            Kind::Scheduled => "scheduled",
            Kind::BeforeRestore => "before-restore",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Kind::Manual => "by hand",
            Kind::Scheduled => "scheduled",
            Kind::BeforeRestore => "before a restore",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Add and update; what is only here now stays.
    Merge,
    /// The section becomes the backup's; what is only here now is removed.
    Replace,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s.trim() {
            "merge" => Some(Mode::Merge),
            "replace" => Some(Mode::Replace),
            _ => None,
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Mode::Merge => "merge",
            Mode::Replace => "replace",
        }
    }
}

/// One section as the file holds it: named items, and whatever the section needs to put
/// them back (which config key held the triggers, whether the config file is YAML).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionData {
    #[serde(default)]
    pub items: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub meta: Value,
}

/// What the stores gave: the sections with their secrets pulled out, the secrets by path,
/// and what could not be included (said, never guessed — "unknown is not zero").
#[derive(Debug, Default)]
pub struct Collected {
    pub sections: BTreeMap<Section, SectionData>,
    pub secrets: BTreeMap<String, Value>,
    pub notes: Vec<String>,
}

/* -------------------------------------- secrets -------------------------------------- */

/// Which keys hold a secret is one rule for the whole product: `config_diff::is_secret_key`
/// (what the config summary redacts is what a backup pulls out). Two of its names, `auth` and
/// `headers`, are blocks: an object under them is a credential block and goes out whole; a
/// scalar under `auth` (`"basic"`, `"login"` — the *kind* of auth the mail or history-store
/// settings name) is not a secret and stays.
pub fn is_secret_value(key: &str, val: &Value) -> bool {
    if !crate::config_diff::is_secret_key(key) {
        return false;
    }
    let k = key.to_ascii_lowercase();
    if k == "auth" || k == "headers" {
        return val.is_object();
    }
    true
}

/// `scheme://user:pass@host/...` → (`scheme://host/...`, `user:pass`), or `None` without userinfo.
fn split_userinfo(s: &str) -> Option<(String, String)> {
    let (scheme, rest) = s.split_once("://")?;
    let end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..end];
    let (userinfo, host) = authority.rsplit_once('@')?;
    if userinfo.is_empty() {
        return None;
    }
    Some((format!("{scheme}://{host}{}", &rest[end..]), userinfo.to_string()))
}

const USERINFO_SUFFIX: &str = "#userinfo";

/// Pull every secret out of `v`, keyed by `prefix` + its JSON pointer, leaving the value
/// without them. A URL's `user:pass@` is a secret whatever its key is called; it is kept under
/// the URL's pointer with `#userinfo` appended.
pub fn strip_secrets(v: &mut Value, prefix: &str, out: &mut BTreeMap<String, Value>) {
    match v {
        Value::Object(m) => {
            let secret_keys: Vec<String> = m.iter().filter(|(k, v)| is_secret_value(k, v)).map(|(k, _)| k.clone()).collect();
            for k in secret_keys {
                if let Some(val) = m.remove(&k) {
                    // Only a value with something in it is a secret; `password: ""` is a shape.
                    if !matches!(&val, Value::Null) && !val.as_str().is_some_and(str::is_empty) {
                        out.insert(format!("{prefix}/{}", escape(&k)), val);
                    }
                }
            }
            for (k, child) in m.iter_mut() {
                strip_secrets(child, &format!("{prefix}/{}", escape(k)), out);
            }
        }
        Value::Array(a) => {
            for (i, child) in a.iter_mut().enumerate() {
                strip_secrets(child, &format!("{prefix}/{i}"), out);
            }
        }
        Value::String(s) => {
            if let Some((clean, userinfo)) = split_userinfo(s) {
                out.insert(format!("{prefix}{USERINFO_SUFFIX}"), Value::String(userinfo));
                *s = clean;
            }
        }
        _ => {}
    }
}

/// Put back the secrets under `prefix` that `strip_secrets` took out. Returns how many went back.
pub fn restore_secrets(v: &mut Value, prefix: &str, secrets: &BTreeMap<String, Value>) -> usize {
    let mut n = 0;
    let head = format!("{prefix}/");
    for (path, val) in secrets {
        let Some(rest) = path.strip_prefix(&head) else { continue };
        if let Some(ptr) = rest.strip_suffix(USERINFO_SUFFIX) {
            if let Some(Value::String(url)) = pointer_mut(v, &format!("/{ptr}")) {
                if let (Some(userinfo), Some((scheme, tail))) = (val.as_str(), url.split_once("://")) {
                    *url = format!("{scheme}://{userinfo}@{tail}");
                    n += 1;
                }
            }
        } else if set_pointer(v, &format!("/{rest}"), val.clone()) {
            n += 1;
        }
    }
    n
}

/// `restore_secrets`, but only where `v` has nothing yet: what a Merge uses to keep the
/// credentials this server holds now when the backup brought none (a backup made without a
/// password must never cost a cluster its live password). Returns how many went back.
pub fn restore_secrets_missing(v: &mut Value, prefix: &str, secrets: &BTreeMap<String, Value>) -> usize {
    let mut n = 0;
    let head = format!("{prefix}/");
    for (path, val) in secrets {
        let Some(rest) = path.strip_prefix(&head) else { continue };
        if let Some(ptr) = rest.strip_suffix(USERINFO_SUFFIX) {
            if let Some(Value::String(url)) = pointer_mut(v, &format!("/{ptr}")) {
                if split_userinfo(url).is_some() {
                    continue;
                }
                if let (Some(userinfo), Some((scheme, tail))) = (val.as_str(), url.split_once("://")) {
                    *url = format!("{scheme}://{userinfo}@{tail}");
                    n += 1;
                }
            }
        } else {
            let present = v.pointer(&format!("/{rest}")).is_some_and(|cur| !cur.is_null() && !cur.as_str().is_some_and(str::is_empty));
            if !present && set_pointer(v, &format!("/{rest}"), val.clone()) {
                n += 1;
            }
        }
    }
    n
}

fn escape(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

fn unescape(k: &str) -> String {
    k.replace("~1", "/").replace("~0", "~")
}

fn pointer_mut<'a>(v: &'a mut Value, ptr: &str) -> Option<&'a mut Value> {
    v.pointer_mut(ptr)
}

/// Set the value at a JSON pointer, creating objects on the way; an array index must exist.
fn set_pointer(v: &mut Value, ptr: &str, val: Value) -> bool {
    let parts: Vec<String> = ptr.trim_start_matches('/').split('/').map(unescape).collect();
    let Some((last, path)) = parts.split_last() else { return false };
    let mut cur = v;
    for p in path {
        cur = match cur {
            Value::Object(m) => m.entry(p.clone()).or_insert_with(|| Value::Object(Map::new())),
            Value::Array(a) => match p.parse::<usize>().ok().and_then(|i| a.get_mut(i)) {
                Some(x) => x,
                None => return false,
            },
            _ => return false,
        };
    }
    match cur {
        Value::Object(m) => {
            m.insert(last.clone(), val);
            true
        }
        Value::Array(a) => match last.parse::<usize>().ok().and_then(|i| a.get_mut(i)) {
            Some(x) => {
                *x = val;
                true
            }
            None => false,
        },
        _ => false,
    }
}

/* ------------------------------------ keyed lists ------------------------------------ */

/// A list of records as named items: by `id`, else `name`, else a short digest of the record,
/// so a record without a name still has a stable key and two identical ones stay two items.
pub fn keyed(list: &[Value], prefix: &str) -> BTreeMap<String, Value> {
    keyed_by(list, prefix, &["id", "name"])
}

/// A cluster's identity in the config is its `name` (`cluster_save`): the same list, keyed so.
pub const CLUSTER_KEYS: [&str; 2] = ["name", "id"];

/// `keyed` with the fields to try, in order.
pub fn keyed_by(list: &[Value], prefix: &str, keys: &[&str]) -> BTreeMap<String, Value> {
    keys_in_order(list, prefix, keys).into_iter().collect()
}

/// The same keys, in the list's own order (a merge keeps that order).
fn keys_in_order(list: &[Value], prefix: &str, keys: &[&str]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = vec![];
    for rec in list {
        let base = keys.iter().find_map(|k| rec.get(*k).and_then(Value::as_str)).map(str::trim).filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| short_digest(rec));
        let mut key = format!("{prefix}{base}");
        let mut i = 2;
        while out.iter().any(|(k, _)| k == &key) {
            key = format!("{prefix}{base}#{i}");
            i += 1;
        }
        out.push((key, rec.clone()));
    }
    out
}

fn short_digest(v: &Value) -> String {
    let h = Sha256::digest(canonical(v));
    format!("#{}", hex::encode(&h[..4]))
}

/// A list after a restore: in Merge the existing order with matching items replaced and new
/// ones appended, in Replace the backup's items alone. `prefix` is what `keyed` was given.
pub fn merge_list(existing: &[Value], incoming: &BTreeMap<String, Value>, prefix: &str, mode: Mode) -> Vec<Value> {
    merge_list_by(existing, incoming, prefix, &["id", "name"], mode)
}

/// `merge_list` with the fields the items were keyed by.
pub fn merge_list_by(existing: &[Value], incoming: &BTreeMap<String, Value>, prefix: &str, keys: &[&str], mode: Mode) -> Vec<Value> {
    if mode == Mode::Replace {
        return incoming.values().cloned().collect();
    }
    let current = keys_in_order(existing, prefix, keys);
    let mut out = vec![];
    let mut used = std::collections::HashSet::new();
    for (k, v) in &current {
        match incoming.get(k) {
            Some(nv) => {
                out.push(nv.clone());
                used.insert(k.clone());
            }
            None => out.push(v.clone()),
        }
    }
    for (k, v) in incoming {
        if !used.contains(k) {
            out.push(v.clone());
        }
    }
    out
}

/// A map after a restore (the same rule as `merge_list`, for items that are a map already).
pub fn merge_items(current: &BTreeMap<String, Value>, incoming: &BTreeMap<String, Value>, mode: Mode) -> BTreeMap<String, Value> {
    match mode {
        Mode::Replace => incoming.clone(),
        Mode::Merge => {
            let mut out = current.clone();
            for (k, v) in incoming {
                out.insert(k.clone(), v.clone());
            }
            out
        }
    }
}

/// Object fields after a restore: Merge keeps a field the backup does not name, Replace does not.
pub fn merge_object(current: &Value, incoming: &Value, mode: Mode) -> Value {
    match (mode, current.as_object(), incoming.as_object()) {
        (Mode::Merge, Some(c), Some(i)) => {
            let mut m = c.clone();
            for (k, v) in i {
                m.insert(k.clone(), v.clone());
            }
            Value::Object(m)
        }
        _ => incoming.clone(),
    }
}

/* --------------------------------------- preview --------------------------------------- */

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionPreview {
    pub id: &'static str,
    pub label: &'static str,
    /// The backup holds this section.
    pub present: bool,
    pub add: Vec<String>,
    pub change: Vec<String>,
    pub same: usize,
    /// Only here now, and gone after a Replace (kept by a Merge).
    pub only_here: Vec<String>,
    /// Only here now, and kept by a Replace too: settings a backup can overwrite but not remove.
    pub kept_anyway: Vec<String>,
}

/// What a restore would do, with no writes: per section, the items the backup would add, the
/// ones it would change, the ones that are the same, the ones only here now that a Replace
/// removes (`only_here`) and the ones only here now that even a Replace keeps (`kept_anyway`,
/// `Section::replace_removes`). Credentials are not compared — they are not in the sections.
pub fn preview(current: &Collected, incoming: &BTreeMap<Section, SectionData>, sections: &[Section]) -> Vec<SectionPreview> {
    sections
        .iter()
        .map(|s| {
            let mut p = SectionPreview { id: s.id(), label: s.label(), ..Default::default() };
            let Some(inc) = incoming.get(s) else { return p };
            p.present = true;
            let cur = current.sections.get(s).map(|d| &d.items).cloned().unwrap_or_default();
            for (k, v) in &inc.items {
                match cur.get(k) {
                    None => p.add.push(k.clone()),
                    Some(c) if c == v => p.same += 1,
                    Some(_) => p.change.push(k.clone()),
                }
            }
            for k in cur.keys() {
                if !inc.items.contains_key(k) {
                    if s.replace_removes(k) { p.only_here.push(k.clone()) } else { p.kept_anyway.push(k.clone()) }
                }
            }
            p
        })
        .collect()
}

/* --------------------------------------- the file --------------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCredentials {
    pub count: usize,
    /// `password` (a backup password the admin typed) or `server` (this server's own key).
    pub scheme: String,
    pub sealed: String,
}

/// The whole document. Private shape of the format; the public one is in docs/HANDBOOK.md.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    format: String,
    format_version: u32,
    core_version: String,
    taken_at: u64,
    taken_by: String,
    kind: Kind,
    sections: BTreeMap<String, SectionData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credentials: Option<FileCredentials>,
    digest: String,
}

/// A backup after `parse`: header, the sections this core knows, and the credentials blob
/// still sealed.
#[derive(Clone, Debug)]
pub struct Parsed {
    pub format_version: u32,
    pub core_version: String,
    pub taken_at: u64,
    pub taken_by: String,
    pub kind: Kind,
    pub sections: BTreeMap<Section, SectionData>,
    /// Section ids in the file this core does not know (a newer minor addition): left alone.
    pub unknown_sections: Vec<String>,
    pub credentials: Option<FileCredentials>,
    pub digest: String,
    pub bytes: usize,
}

impl Parsed {
    pub fn header(&self) -> Value {
        json!({
            "formatVersion": self.format_version, "coreVersion": self.core_version,
            "takenAt": self.taken_at, "takenBy": self.taken_by,
            // The file's own account of itself: who and when are what it says, not what this
            // server knows. The digest proves the sections were not edited, not who wrote them.
            "says": { "takenBy": self.taken_by, "takenAt": self.taken_at, "coreVersion": self.core_version, "verified": false },
            "kind": self.kind.id(), "kindLabel": self.kind.label(),
            "sections": self.sections.keys().map(|s| s.id()).collect::<Vec<_>>(),
            "unknownSections": self.unknown_sections,
            "credentials": self.credentials.as_ref().map(|c| json!({ "count": c.count, "scheme": c.scheme })),
            "bytes": self.bytes,
        })
    }
}

/// A refusal the UI can match on: `kind` is stable, `message` is for a person.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub kind: &'static str,
    pub message: String,
}

impl Refusal {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Refusal {
        Refusal { kind, message: message.into() }
    }
    pub fn to_json(&self) -> Value {
        json!({ "ok": false, "kind": self.kind, "message": self.message })
    }
}

fn canonical(v: &Value) -> Vec<u8> {
    // serde_json's Map is a BTreeMap (no `preserve_order`), so this is canonical by construction.
    serde_json::to_vec(v).unwrap_or_default()
}

pub fn digest_of(sections: &BTreeMap<String, SectionData>) -> String {
    let v = serde_json::to_value(sections).unwrap_or(Value::Null);
    format!("sha256:{}", hex::encode(Sha256::digest(canonical(&v))))
}

/// The associated data a server-sealed credentials blob is bound to: this digest, nothing else.
pub fn server_aad(digest: &str) -> String {
    format!("backup:credentials:{digest}")
}

/// Who or what the header says took the backup.
pub struct Header<'a> {
    pub core_version: &'a str,
    pub taken_at: u64,
    pub taken_by: &'a str,
    pub kind: Kind,
}

/// How the credentials are sealed into the file, or `None` to leave them out.
pub enum Sealer<'a> {
    /// A backup password the admin typed; checked for length here.
    Password(&'a str),
    /// This server's own key: `(aad, plain) -> sealed`.
    Server(&'a dyn Fn(&str, &str) -> Result<String, String>),
}

pub fn check_password(pw: &str) -> Result<(), Refusal> {
    if pw.chars().count() < MIN_PASSWORD {
        return Err(Refusal::new("weak_password", format!("the backup password needs at least {MIN_PASSWORD} characters")));
    }
    Ok(())
}

/// The file as text. `collected.secrets` go in only with a `sealer`; without one they are left
/// out and the file has no `credentials` key (`Parsed::header` then says `credentials: null`;
/// the `BACKUP_CREATE` reply says `credentials: "none"`).
pub fn build(header: &Header, collected: &Collected, sealer: Option<Sealer>) -> Result<String, Refusal> {
    let sections: BTreeMap<String, SectionData> = collected.sections.iter().map(|(s, d)| (s.id().to_string(), d.clone())).collect();
    let digest = digest_of(&sections);
    let credentials = match sealer {
        None => None,
        Some(sealer) => {
            let count = collected.secrets.len();
            let plain = serde_json::to_string(&json!({ "digest": digest, "secrets": collected.secrets })).map_err(|e| Refusal::new("io", e.to_string()))?;
            let (scheme, sealed) = match sealer {
                Sealer::Password(pw) => {
                    check_password(pw)?;
                    ("password", crate::crypto::seal(&plain, pw).map_err(|e| Refusal::new("io", e))?)
                }
                Sealer::Server(seal) => ("server", seal(&server_aad(&digest), &plain).map_err(|e| Refusal::new("no_server_key", e))?),
            };
            Some(FileCredentials { count, scheme: scheme.into(), sealed })
        }
    };
    let doc = Document {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        core_version: header.core_version.into(),
        taken_at: header.taken_at,
        taken_by: header.taken_by.into(),
        kind: header.kind,
        sections,
        credentials,
        digest,
    };
    serde_json::to_string_pretty(&doc).map(|s| s + "\n").map_err(|e| Refusal::new("io", e.to_string()))
}

/// Read a backup: the format, a version this core understands, and the digest over its sections.
pub fn parse(text: &str) -> Result<Parsed, Refusal> {
    if text.len() > MAX_FILE_BYTES {
        return Err(Refusal::new("too_large", format!("the file is over {} MB", MAX_FILE_BYTES / 1024 / 1024)));
    }
    let doc: Document = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| Refusal::new("not_a_backup", format!("this is not an ElasticPro backup file: {e}")))?;
    if doc.format != FORMAT {
        return Err(Refusal::new("not_a_backup", format!("this is not an ElasticPro backup file (format {:?})", doc.format)));
    }
    if doc.format_version > FORMAT_VERSION {
        return Err(Refusal::new("newer_format", format!(
            "this backup was made by a newer ElasticPro (format {} from version {}); this server reads format {} — upgrade it first",
            doc.format_version, doc.core_version, FORMAT_VERSION)));
    }
    if doc.format_version == 0 {
        return Err(Refusal::new("not_a_backup", "formatVersion 0 is not a backup"));
    }
    if digest_of(&doc.sections) != doc.digest {
        return Err(Refusal::new("corrupt", "the file's digest does not match its contents: it was damaged or edited"));
    }
    let mut sections = BTreeMap::new();
    let mut unknown = vec![];
    for (id, data) in doc.sections {
        match Section::parse(&id) {
            Some(s) => {
                sections.insert(s, data);
            }
            None => unknown.push(id),
        }
    }
    if let Some(c) = &doc.credentials {
        if c.scheme != "password" && c.scheme != "server" {
            return Err(Refusal::new("corrupt", format!("credentials scheme {:?} is not one this server knows", c.scheme)));
        }
    }
    Ok(Parsed {
        format_version: doc.format_version,
        core_version: doc.core_version,
        taken_at: doc.taken_at,
        taken_by: doc.taken_by,
        kind: doc.kind,
        sections,
        unknown_sections: unknown,
        credentials: doc.credentials,
        digest: doc.digest,
        bytes: text.len(),
    })
}

/// How a restore may open the credentials blob.
pub enum Opener<'a> {
    Password(&'a str),
    /// This server's own key: `(aad, sealed) -> plain`, `None` when it does not open.
    Server(&'a dyn Fn(&str, &str) -> Option<String>),
}

/// The credentials, or `Ok(None)` when the file has none. `bad_password` for a wrong password,
/// `password_needed` for a password-sealed blob opened without one, `server_key` for a
/// server-sealed blob this server's key does not open, `tampered` when the blob belongs to
/// another file.
pub fn open_credentials(parsed: &Parsed, opener: Option<Opener>) -> Result<Option<BTreeMap<String, Value>>, Refusal> {
    let Some(c) = &parsed.credentials else { return Ok(None) };
    let plain = match (c.scheme.as_str(), opener) {
        ("password", Some(Opener::Password(pw))) => match crate::crypto::open(&c.sealed, pw) {
            Ok(p) => p,
            Err(crate::crypto::OpenError::WrongMaster) => return Err(Refusal::new("bad_password", "the backup password is not the one this file was sealed with")),
            Err(_) => return Err(Refusal::new("corrupt", "the credentials in this file are malformed")),
        },
        ("password", _) => return Err(Refusal::new("password_needed", "this file's credentials are sealed with a backup password: type it, or restore without credentials")),
        ("server", Some(Opener::Server(open))) => open(&server_aad(&parsed.digest), &c.sealed)
            .ok_or_else(|| Refusal::new("server_key", "this file's credentials were sealed by another server's key: they cannot be restored here (the settings can)"))?,
        ("server", _) => return Err(Refusal::new("server_key", "this file's credentials are sealed under a server key, not a password")),
        _ => return Err(Refusal::new("corrupt", "unknown credentials scheme")),
    };
    let v: Value = serde_json::from_str(&plain).map_err(|_| Refusal::new("corrupt", "the credentials in this file are malformed"))?;
    if v.get("digest").and_then(Value::as_str) != Some(parsed.digest.as_str()) {
        return Err(Refusal::new("tampered", "the credentials in this file belong to another backup"));
    }
    let secrets = v.get("secrets").and_then(Value::as_object).ok_or_else(|| Refusal::new("corrupt", "the credentials in this file are malformed"))?;
    Ok(Some(secrets.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
}

/* ------------------------------------- kept files ------------------------------------- */

/// `elasticpro-backup-YYYYMMDD-HHMMSS-<kind>.epbak`, local time: the name sorts by when.
pub fn file_name(local: chrono::NaiveDateTime, kind: Kind) -> String {
    format!("{NAME_PREFIX}{}-{}{EXT}", local.format("%Y%m%d-%H%M%S"), kind.id())
}

/// A kept file's name as a message may give it: ours, and nothing that walks anywhere.
pub fn safe_name(name: &str) -> Result<&str, Refusal> {
    let ok = name.starts_with(NAME_PREFIX)
        && name.ends_with(EXT)
        && name.len() <= 120
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !name.contains("..");
    if ok { Ok(name) } else { Err(Refusal::new("bad_request", format!("{name:?} is not the name of a kept backup"))) }
}

/// A kept backup as the list shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub name: String,
    pub bytes: u64,
    pub taken_at: u64,
    pub taken_by: String,
    pub kind: &'static str,
    pub kind_label: &'static str,
    pub sections: Vec<&'static str>,
    /// `password`, `server` or `none`.
    pub credentials: String,
    pub credentials_count: usize,
    pub core_version: String,
    /// The file reads as a backup; `false` names the problem in `problem`.
    pub readable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// The kept backups in `dir`, newest first. Each is read and checked; one that does not read
/// stays in the list as unreadable rather than disappearing.
pub fn list_kept(dir: &std::path::Path) -> Vec<Kept> {
    let mut out: Vec<Kept> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            safe_name(&name).ok()?;
            let bytes = e.metadata().ok()?.len();
            Some(match std::fs::read_to_string(e.path()).map_err(|e| e.to_string()).and_then(|t| parse(&t).map_err(|r| r.message)) {
                Ok(p) => Kept {
                    name,
                    bytes,
                    taken_at: p.taken_at,
                    taken_by: p.taken_by,
                    kind: p.kind.id(),
                    kind_label: p.kind.label(),
                    sections: p.sections.keys().map(|s| s.id()).collect(),
                    credentials: p.credentials.as_ref().map(|c| c.scheme.clone()).unwrap_or_else(|| "none".into()),
                    credentials_count: p.credentials.as_ref().map(|c| c.count).unwrap_or(0),
                    core_version: p.core_version,
                    readable: true,
                    problem: None,
                },
                Err(problem) => Kept {
                    name, bytes, taken_at: 0, taken_by: String::new(), kind: "unknown", kind_label: "unreadable",
                    sections: vec![], credentials: "unknown".into(), credentials_count: 0, core_version: String::new(),
                    readable: false, problem: Some(problem),
                },
            })
        })
        .collect();
    out.sort_by(|a, b| age_key(&b.name).cmp(&age_key(&a.name)));
    out
}

/// The order kept backups were made in, from the name: the local time it starts with, then the
/// `-2`, `-3`… that a second one in the same second gets. Plain name order is wrong there
/// (`-manual-2.epbak` sorts before `-manual.epbak`), and rotation then removed the copy just
/// made. One definition for the listing (newest first) and for rotation (oldest first).
fn age_key(name: &str) -> (&str, u32, &str) {
    let rest = name.strip_prefix(NAME_PREFIX).unwrap_or(name);
    let stem = rest.strip_suffix(EXT).unwrap_or(rest);
    let time = stem.get(..15).unwrap_or(stem);
    let n = stem.rsplit_once('-').and_then(|(_, n)| n.parse::<u32>().ok()).unwrap_or(1);
    (time, n, name)
}

/// Remove the oldest kept backups beyond `keep`; returns the names removed. Not audited here:
/// every caller goes through `BackupState::prune` (core.rs), which logs each removal.
fn rotate(dir: &std::path::Path, keep: usize) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| safe_name(n).is_ok())
        .collect();
    names.sort_by(|a, b| age_key(a).cmp(&age_key(b)));
    let excess = names.len().saturating_sub(keep.max(MIN_KEEP));
    let mut removed = vec![];
    for n in names.into_iter().take(excess) {
        if std::fs::remove_file(dir.join(&n)).is_ok() {
            removed.push(n);
        }
    }
    removed
}

/* --------------------------------------- schedule --------------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Every {
    Day,
    Week,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub at: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The local day it ran on (`YYYY-MM-DD`): one run per day, whatever the clock does.
    #[serde(default)]
    pub local_day: String,
}

/// The scheduled backup's settings (`<data>/backups/schedule.json`). Shipped on: daily at
/// 02:00 server time, the last 14 kept, every section, credentials sealed under the server's key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Schedule {
    pub enabled: bool,
    pub every: Every,
    pub at: String,
    pub keep: usize,
    pub sections: Vec<Section>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<LastRun>,
}

impl Default for Schedule {
    fn default() -> Schedule {
        Schedule { enabled: true, every: Every::Day, at: DEFAULT_AT.into(), keep: DEFAULT_KEEP, sections: Section::ALL.to_vec(), last: None }
    }
}

impl Schedule {
    pub fn validate(&self) -> Result<(), String> {
        crate::volume::schedule::parse_hhmm(&self.at).ok_or_else(|| format!("at: {:?} is not HH:MM", self.at))?;
        if !(MIN_KEEP..=MAX_KEEP).contains(&self.keep) {
            return Err(format!("keep: {MIN_KEEP}–{MAX_KEEP}"));
        }
        if self.sections.is_empty() {
            return Err("sections: tick at least one".into());
        }
        Ok(())
    }

    /// Apply a `BACKUP_SCHEDULE_SET` body: absent keeps a field; `last` is the core's, never set here.
    pub fn with_message(&self, msg: &Value) -> Result<Schedule, String> {
        let obj = msg.as_object().ok_or("schedule must be an object")?;
        const KNOWN: [&str; 5] = ["enabled", "every", "at", "keep", "sections"];
        if let Some(k) = obj.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            return Err(format!("schedule: {k:?} is not a setting (enabled, every, at, keep, sections)"));
        }
        let mut next = self.clone();
        if let Some(e) = obj.get("enabled") {
            next.enabled = e.as_bool().ok_or("enabled: true or false")?;
        }
        if let Some(e) = obj.get("every") {
            next.every = match e.as_str() {
                Some("day") => Every::Day,
                Some("week") => Every::Week,
                _ => return Err("every: day or week".into()),
            };
        }
        if let Some(a) = obj.get("at") {
            next.at = a.as_str().ok_or("at: HH:MM")?.trim().to_string();
        }
        if let Some(k) = obj.get("keep") {
            next.keep = k.as_u64().ok_or("keep: a whole number")? as usize;
        }
        if obj.contains_key("sections") {
            next.sections = Section::from_message(obj.get("sections"))?;
        }
        next.validate()?;
        Ok(next)
    }

    /// Due: on, the time of day has passed, and it has not run this local day (every day) or in
    /// the last seven (every week). Missed by a stopped server, it runs at the next tick.
    pub fn due(&self, local_now: chrono::NaiveDateTime) -> bool {
        if !self.enabled {
            return false;
        }
        let Some(at) = crate::volume::schedule::parse_hhmm(&self.at) else { return false };
        let last_day = self.last.as_ref().and_then(|l| crate::volume::schedule::parse_day(&l.local_day));
        let today = local_now.date();
        let gap = match self.every {
            Every::Day => 1,
            Every::Week => 7,
        };
        local_now.time() >= at && last_day.is_none_or(|l| l + chrono::Duration::days(gap) <= today)
    }

    /// When it next runs, as a local time; `None` while off.
    pub fn next_run(&self, local_now: chrono::NaiveDateTime) -> Option<chrono::NaiveDateTime> {
        if !self.enabled {
            return None;
        }
        let at = crate::volume::schedule::parse_hhmm(&self.at)?;
        if self.due(local_now) {
            return Some(local_now);
        }
        let last_day = self.last.as_ref().and_then(|l| crate::volume::schedule::parse_day(&l.local_day));
        let gap = if self.every == Every::Day { 1 } else { 7 };
        let earliest_day = last_day.map(|l| l + chrono::Duration::days(gap)).unwrap_or(local_now.date());
        let day = if earliest_day > local_now.date() || local_now.time() < at && earliest_day == local_now.date() {
            earliest_day
        } else {
            local_now.date() + chrono::Duration::days(1)
        };
        Some(day.and_time(at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn section_ids_labels_and_parsing_agree() {
        for s in Section::ALL {
            assert_eq!(Section::parse(s.id()), Some(s));
            assert!(!s.label().is_empty());
        }
        assert_eq!(Section::parse("nope"), None);
        assert_eq!(Section::from_message(None).unwrap(), Section::ALL.to_vec());
        assert_eq!(Section::from_message(Some(&json!(["play", "clusters", "play"]))).unwrap(), vec![Section::Clusters, Section::Play]);
        assert!(Section::from_message(Some(&json!([]))).is_err());
        assert!(Section::from_message(Some(&json!(["tokens"]))).is_err());
    }

    #[test]
    fn secrets_leave_the_section_and_come_back() {
        let mut v = json!({
            "name": "prod", "url": "https://svc:pw@prod:9200/", "username": "elastic", "password": "p1",
            "apiKey": "k", "api_key": "", "note": "x", "nested": { "bearer": "b", "keep": 1 },
            "list": [{ "token": "t" }]
        });
        let mut out = BTreeMap::new();
        strip_secrets(&mut v, "clusters/prod", &mut out);
        let text = v.to_string();
        for s in ["p1", "\"k\"", "svc:pw", "\"b\"", "\"t\""] {
            assert!(!text.contains(s), "{s} still in {text}");
        }
        assert_eq!(v["url"], "https://prod:9200/");
        assert_eq!(v["username"], "elastic", "a username is not a secret");
        assert_eq!(v["nested"]["keep"], 1);
        assert_eq!(out.len(), 5, "{out:?}");
        assert_eq!(out["clusters/prod/url#userinfo"], "svc:pw");
        assert_eq!(out["clusters/prod/list/0/token"], "t");
        assert!(!out.contains_key("clusters/prod/api_key"), "an empty secret is a shape, not a secret");

        let n = restore_secrets(&mut v, "clusters/prod", &out);
        assert_eq!(n, 5);
        assert_eq!(v["url"], "https://svc:pw@prod:9200/");
        assert_eq!(v["password"], "p1");
        assert_eq!(v["nested"]["bearer"], "b");
        assert_eq!(v["list"][0]["token"], "t");
        // Another item's secrets do not land here.
        let mut other = json!({ "name": "other" });
        assert_eq!(restore_secrets(&mut other, "clusters/other", &out), 0);
        assert_eq!(other, json!({ "name": "other" }));
    }

    #[test]
    fn the_secret_rule_is_the_config_summarys_plus_credential_blocks() {
        // One definition (config_diff::is_secret_key): every spelling the summary redacts, a
        // backup pulls out — the names the review asked for among them.
        let mut v = json!({
            "zabbixToken": "t1", "clientSecret": "s1", "x-api-key": "k1", "sshKey": "-----BEGIN", "sharedAuthHeader": "Basic x",
            "headers": { "X-Api-Key": "k2" }, "auth": { "user": "u", "pass": "p" },
            "mail": { "auth": "login", "user": "svc" }, "store": { "auth": "basic" },
            "username": "u", "keyFile": "/k", "url": "https://h:9200", "name": "n"
        });
        let mut out = BTreeMap::new();
        strip_secrets(&mut v, "x", &mut out);
        let keys: Vec<&String> = out.keys().collect();
        assert_eq!(keys, vec!["x/auth", "x/clientSecret", "x/headers", "x/sharedAuthHeader", "x/sshKey", "x/x-api-key", "x/zabbixToken"], "{out:?}");
        assert_eq!(out["x/headers"], json!({ "X-Api-Key": "k2" }), "a headers block goes out whole");
        assert_eq!(out["x/auth"], json!({ "user": "u", "pass": "p" }), "an auth block goes out whole");
        assert_eq!(v["mail"]["auth"], "login", "a scalar auth is the kind of auth, not a secret");
        assert_eq!(v["store"]["auth"], "basic");
        assert_eq!(v["username"], "u");
        assert_eq!(v["keyFile"], "/k");
        for (k, val, want) in [("zabbixToken", json!("t"), true), ("clientSecret", json!("s"), true), ("x-api-key", json!("k"), true),
                               ("sshKey", json!("k"), true), ("headers", json!({ "a": 1 }), true), ("auth", json!("basic"), false),
                               ("keyFile", json!("/k"), false), ("tokenField", json!("x"), true), ("user", json!("u"), false)] {
            assert_eq!(is_secret_value(k, &val), want, "{k}");
        }
        assert_eq!(restore_secrets(&mut v, "x", &out), 7);
        assert_eq!(v["headers"]["X-Api-Key"], "k2");
    }

    #[test]
    fn a_merge_fills_only_the_credentials_the_backup_lacks() {
        // What this server holds now, as `backup_collect` would give it.
        let mut live: BTreeMap<String, Value> = BTreeMap::new();
        live.insert("clusters/prod/config/password".into(), json!("live-pw"));
        live.insert("clusters/prod/config/url#userinfo".into(), json!("svc:live"));
        live.insert("clusters/prod/config/apiKey".into(), json!("live-key"));
        // The backup brought the apiKey only.
        let mut item = json!({ "config": { "name": "prod", "url": "https://prod:9200", "apiKey": "backup-key", "password": "" } });
        assert_eq!(restore_secrets_missing(&mut item, "clusters/prod", &live), 2);
        assert_eq!(item["config"]["apiKey"], "backup-key", "what the backup brought wins");
        assert_eq!(item["config"]["password"], "live-pw", "an empty password is nothing: the live one stays");
        assert_eq!(item["config"]["url"], "https://svc:live@prod:9200");
        // A URL that already carries userinfo is left as it is.
        let mut item2 = json!({ "config": { "url": "https://a:b@prod:9200" } });
        assert_eq!(restore_secrets_missing(&mut item2, "clusters/prod", &live), 2, "password and apiKey, not the userinfo");
        assert_eq!(item2["config"]["url"], "https://a:b@prod:9200");
    }

    #[test]
    fn a_replace_removes_records_and_clearable_blocks_and_nothing_else() {
        assert!(Section::Clusters.replace_removes("prod") && Section::Clusters.replace_removes("shared-credential"));
        assert!(Section::Trust.replace_removes("jump:a") && Section::Alerts.replace_removes("rule:r"));
        assert!(!Section::Requests.replace_removes("policy") && !Section::Requests.replace_removes("defaults"));
        assert!(Section::Zabbix.replace_removes("role:kd") && Section::Zabbix.replace_removes("roleMap") && !Section::Zabbix.replace_removes("link"));
        assert!(Section::Reports.replace_removes("template:t") && Section::Reports.replace_removes("volume"));
        assert!(!Section::Reports.replace_removes("mail") && !Section::Reports.replace_removes("schedules"));
        assert!(Section::Play.replace_removes("display:tv") && Section::Play.replace_removes("exclude") && !Section::Play.replace_removes("watch"));
        assert!(!Section::Data.replace_removes("historyStore") && !Section::Versions.replace_removes("version:1"));
        // And the preview files an only-here item under the right heading.
        let mut current = Collected::default();
        current.sections.insert(Section::Play, SectionData { items: [("watch".to_string(), json!(1)), ("display:tv".to_string(), json!(1))].into(), meta: Value::Null });
        let incoming: BTreeMap<Section, SectionData> = [(Section::Play, SectionData::default())].into();
        let p = preview(&current, &incoming, &[Section::Play]);
        assert_eq!(p[0].only_here, vec!["display:tv"]);
        assert_eq!(p[0].kept_anyway, vec!["watch"]);
    }

    #[test]
    fn keyed_lists_merge_and_replace() {
        let existing = vec![json!({ "name": "a", "v": 1 }), json!({ "name": "b", "v": 1 }), json!({ "v": 9 })];
        let k = keyed(&existing, "rule:");
        assert_eq!(k.len(), 3);
        assert!(k.contains_key("rule:a") && k.contains_key("rule:b"));
        assert!(k.keys().any(|x| x.starts_with("rule:#")), "{k:?}");
        let incoming: BTreeMap<String, Value> = [("rule:b".to_string(), json!({ "name": "b", "v": 2 })), ("rule:c".to_string(), json!({ "name": "c" }))].into();
        let merged = merge_list(&existing, &incoming, "rule:", Mode::Merge);
        assert_eq!(merged.len(), 4);
        assert_eq!(merged[1]["v"], 2, "b updated in place");
        assert_eq!(merged[3]["name"], "c", "c appended");
        let replaced = merge_list(&existing, &incoming, "rule:", Mode::Replace);
        assert_eq!(replaced.len(), 2);
        // Two identical unnamed records are two items, not one lost.
        let twins = keyed(&[json!({ "v": 1 }), json!({ "v": 1 })], "");
        assert_eq!(twins.len(), 2);
    }

    #[test]
    fn preview_counts_add_change_same_and_only_here() {
        let mut current = Collected::default();
        current.sections.insert(Section::Clusters, SectionData {
            items: [("a".to_string(), json!(1)), ("b".to_string(), json!(1)), ("c".to_string(), json!(1))].into(), meta: Value::Null });
        let incoming: BTreeMap<Section, SectionData> = [(Section::Clusters, SectionData {
            items: [("a".to_string(), json!(1)), ("b".to_string(), json!(2)), ("d".to_string(), json!(1))].into(), meta: Value::Null })].into();
        let p = preview(&current, &incoming, &[Section::Clusters, Section::Play]);
        assert_eq!(p[0].add, vec!["d"]);
        assert_eq!(p[0].change, vec!["b"]);
        assert_eq!(p[0].same, 1);
        assert_eq!(p[0].only_here, vec!["c"]);
        assert!(p[0].present);
        assert!(!p[1].present, "a section the backup lacks is said so, not counted as empty");
    }

    fn sample() -> Collected {
        let mut c = Collected::default();
        c.sections.insert(Section::Clusters, SectionData { items: [("prod".to_string(), json!({ "name": "prod" }))].into(), meta: json!({ "yaml": false }) });
        c.secrets.insert("clusters/prod/password".into(), json!("hunter2-hunter2"));
        c
    }

    #[test]
    fn a_backup_without_a_password_carries_no_secret_at_all() {
        let h = Header { core_version: "0.3.55", taken_at: 1, taken_by: "kd", kind: Kind::Manual };
        let text = build(&h, &sample(), None).unwrap();
        assert!(!text.contains("hunter2"), "{text}");
        let raw: Value = serde_json::from_str(&text).unwrap();
        assert!(raw.get("credentials").is_none(), "no credentials key in the file: {text}");
        let p = parse(&text).unwrap();
        assert!(p.credentials.is_none());
        assert_eq!(p.header()["credentials"], Value::Null, "a preview says null");
        assert_eq!(p.sections[&Section::Clusters].items["prod"]["name"], "prod");
        assert_eq!(open_credentials(&p, Some(Opener::Password("whatever-12345"))).unwrap(), None);
    }

    #[test]
    fn a_password_seals_the_secrets_and_the_wrong_one_is_refused() {
        let h = Header { core_version: "0.3.55", taken_at: 1, taken_by: "kd", kind: Kind::Manual };
        assert_eq!(build(&h, &sample(), Some(Sealer::Password("short"))).unwrap_err().kind, "weak_password");
        let text = build(&h, &sample(), Some(Sealer::Password("correct-horse-battery"))).unwrap();
        assert!(!text.contains("hunter2"), "sealed, so never in the clear: {text}");
        let p = parse(&text).unwrap();
        assert_eq!(p.credentials.as_ref().unwrap().count, 1);
        assert_eq!(open_credentials(&p, Some(Opener::Password("correct-horse-batterx"))).unwrap_err().kind, "bad_password");
        assert_eq!(open_credentials(&p, None).unwrap_err().kind, "password_needed");
        let s = open_credentials(&p, Some(Opener::Password("correct-horse-battery"))).unwrap().unwrap();
        assert_eq!(s["clusters/prod/password"], "hunter2-hunter2");
    }

    #[test]
    fn a_server_sealed_blob_opens_with_the_key_it_was_sealed_with() {
        let key = [3u8; 32];
        let seal = |aad: &str, plain: &str| crate::crypto::seal_with_key(plain, &key, aad);
        let h = Header { core_version: "0.3.55", taken_at: 1, taken_by: "system", kind: Kind::Scheduled };
        let text = build(&h, &sample(), Some(Sealer::Server(&seal))).unwrap();
        let p = parse(&text).unwrap();
        assert_eq!(p.credentials.as_ref().unwrap().scheme, "server");
        let open_ok = |aad: &str, sealed: &str| crate::crypto::open_with_key(sealed, &key, aad).ok();
        let other = [4u8; 32];
        let open_other = |aad: &str, sealed: &str| crate::crypto::open_with_key(sealed, &other, aad).ok();
        assert_eq!(open_credentials(&p, Some(Opener::Server(&open_other))).unwrap_err().kind, "server_key");
        assert_eq!(open_credentials(&p, Some(Opener::Password("correct-horse-battery"))).unwrap_err().kind, "server_key");
        assert!(open_credentials(&p, Some(Opener::Server(&open_ok))).unwrap().is_some());
    }

    #[test]
    fn edited_newer_or_foreign_files_are_refused() {
        let h = Header { core_version: "0.3.55", taken_at: 1, taken_by: "kd", kind: Kind::Manual };
        let text = build(&h, &sample(), Some(Sealer::Password("correct-horse-battery"))).unwrap();
        let edited = text.replace("\"prod\"", "\"prod2\"");
        assert_eq!(parse(&edited).unwrap_err().kind, "corrupt");
        let mut v: Value = serde_json::from_str(&text).unwrap();
        v["formatVersion"] = json!(FORMAT_VERSION + 1);
        assert_eq!(parse(&v.to_string()).unwrap_err().kind, "newer_format");
        assert_eq!(parse("{\"clusters\":[]}").unwrap_err().kind, "not_a_backup");
        assert_eq!(parse("not json").unwrap_err().kind, "not_a_backup");
        // A credentials blob moved from another backup is seen: its inner digest is another's.
        let other = {
            let mut c = sample();
            c.sections.get_mut(&Section::Clusters).unwrap().items.insert("dev".into(), json!({ "name": "dev" }));
            build(&h, &c, Some(Sealer::Password("correct-horse-battery"))).unwrap()
        };
        let mut spliced: Value = serde_json::from_str(&other).unwrap();
        let from: Value = serde_json::from_str(&text).unwrap();
        spliced["credentials"] = from["credentials"].clone();
        let p = parse(&spliced.to_string()).unwrap();
        assert_eq!(open_credentials(&p, Some(Opener::Password("correct-horse-battery"))).unwrap_err().kind, "tampered");
    }

    #[test]
    fn unknown_sections_are_kept_aside_not_refused() {
        let h = Header { core_version: "0.3.99", taken_at: 1, taken_by: "kd", kind: Kind::Manual };
        let text = build(&h, &sample(), None).unwrap();
        let mut v: Value = serde_json::from_str(&text).unwrap();
        let mut sections: BTreeMap<String, SectionData> = serde_json::from_value(v["sections"].clone()).unwrap();
        sections.insert("teleport".into(), SectionData::default());
        v["sections"] = serde_json::to_value(&sections).unwrap();
        v["digest"] = json!(digest_of(&sections));
        let p = parse(&v.to_string()).unwrap();
        assert_eq!(p.unknown_sections, vec!["teleport"]);
        assert_eq!(p.sections.len(), 1);
    }

    #[test]
    fn file_names_sort_by_time_and_only_ours_are_accepted() {
        let n = file_name(at("2026-11-05 02:00"), Kind::Scheduled);
        assert_eq!(n, "elasticpro-backup-20261105-020000-scheduled.epbak");
        assert!(safe_name(&n).is_ok());
        assert!(file_name(at("2026-11-04 18:42"), Kind::Manual) < n);
        for bad in ["../x.epbak", "elasticpro-backup-../a.epbak", "schedule.json", "elasticpro-backup-1.epbak/", "x.epbak", "elasticpro-backup-1.epbak.tmp"] {
            assert!(safe_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn kept_files_are_listed_newest_first_and_rotated_oldest_first() {
        let dir = std::env::temp_dir().join(format!("elasticpro-backup-rot-{}-{}", std::process::id(), crate::fleet::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let h = Header { core_version: "0.3.55", taken_at: 5, taken_by: "kd", kind: Kind::Manual };
        for (i, kind) in [Kind::Scheduled, Kind::Manual, Kind::BeforeRestore].iter().enumerate() {
            let name = file_name(at(&format!("2026-11-0{} 02:00", i + 1)), *kind);
            std::fs::write(dir.join(name), build(&Header { kind: *kind, ..h }, &sample(), None).unwrap()).unwrap();
        }
        std::fs::write(dir.join("elasticpro-backup-20261109-020000-manual.epbak"), "garbage").unwrap();
        std::fs::write(dir.join("schedule.json"), "{}").unwrap();
        let kept = list_kept(&dir);
        assert_eq!(kept.len(), 4, "the schedule file is not a backup");
        assert!(!kept[0].readable && kept[0].problem.is_some(), "a damaged file is listed as such");
        assert_eq!(kept[1].kind, "before-restore");
        assert_eq!(kept[3].kind, "scheduled");
        let removed = rotate(&dir, 2);
        assert_eq!(removed.len(), 2);
        assert!(removed[0].contains("20261101"));
        assert_eq!(list_kept(&dir).len(), 2);
        assert!(rotate(&dir, 0).len() == 1, "keep is never below MIN_KEEP");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_backup_in_the_same_second_is_the_newer_one() {
        let dir = std::env::temp_dir().join(format!("elasticpro-backup-same-{}-{}", std::process::id(), crate::fleet::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let h = Header { core_version: "0.3.55", taken_at: 5, taken_by: "kd", kind: Kind::Manual };
        let text = build(&h, &sample(), None).unwrap();
        for n in ["elasticpro-backup-20261107-090227-manual.epbak", "elasticpro-backup-20261107-090227-manual-2.epbak",
                  "elasticpro-backup-20261107-090227-manual-10.epbak"] {
            std::fs::write(dir.join(n), &text).unwrap();
        }
        assert_eq!(list_kept(&dir)[0].name, "elasticpro-backup-20261107-090227-manual-10.epbak", "newest first");
        assert_eq!(rotate(&dir, 1), vec!["elasticpro-backup-20261107-090227-manual.epbak", "elasticpro-backup-20261107-090227-manual-2.epbak"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_schedule_is_due_once_a_day_or_week_after_its_time() {
        let s = Schedule::default();
        assert!(s.enabled && s.at == "02:00" && s.keep == 14 && s.sections.len() == 9);
        assert!(!s.due(at("2026-11-05 01:59")));
        assert!(s.due(at("2026-11-05 02:00")));
        let ran = Schedule { last: Some(LastRun { at: 1, ok: true, name: None, bytes: 0, message: None, local_day: "2026-11-05".into() }), ..s.clone() };
        assert!(!ran.due(at("2026-11-05 23:59")));
        assert!(ran.due(at("2026-11-06 02:00")));
        assert_eq!(ran.next_run(at("2026-11-05 23:59")), Some(at("2026-11-06 02:00")));
        assert_eq!(s.next_run(at("2026-11-05 01:00")), Some(at("2026-11-05 02:00")));
        assert_eq!(s.next_run(at("2026-11-05 03:00")), Some(at("2026-11-05 03:00")), "overdue: now");
        let weekly = Schedule { every: Every::Week, ..ran.clone() };
        assert!(!weekly.due(at("2026-11-11 02:00")));
        assert!(weekly.due(at("2026-11-12 02:00")));
        assert_eq!(weekly.next_run(at("2026-11-06 10:00")), Some(at("2026-11-12 02:00")));
        let off = Schedule { enabled: false, ..s.clone() };
        assert!(!off.due(at("2026-11-05 02:00")));
        assert_eq!(off.next_run(at("2026-11-05 02:00")), None);
    }

    #[test]
    fn schedule_messages_are_checked() {
        let s = Schedule::default();
        let n = s.with_message(&json!({ "enabled": false, "every": "week", "at": "23:30", "keep": 30, "sections": ["play"] })).unwrap();
        assert!(!n.enabled && n.every == Every::Week && n.at == "23:30" && n.keep == 30 && n.sections == vec![Section::Play]);
        assert!(s.with_message(&json!({ "at": "2:00" })).is_err());
        assert!(s.with_message(&json!({ "keep": 0 })).is_err());
        assert!(s.with_message(&json!({ "keep": 91 })).is_err());
        assert!(s.with_message(&json!({ "every": "hour" })).is_err());
        assert!(s.with_message(&json!({ "last": {} })).is_err(), "last is the core's");
        assert!(s.with_message(&json!({ "password": "x" })).is_err(), "no password is ever stored with the schedule");
    }
}
