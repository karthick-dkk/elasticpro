//! The stores' side of backup and restore: which store each section is read from and written
//! back to, the messages (`BACKUP_*`, administrators only) and the daily timer. The format,
//! the comparison and the merge rules are in the parent module and know no store.
//!
//! A restore never writes a store directly when the store has a setter of its own: the config
//! goes through `Core::store_config` (a version kept, who and what recorded), the policy through
//! `policy_apply`, Play through `apply_change`, the delay sink through `set_delay_sink_config`,
//! cluster credentials through `ClusterSecrets::set_bound` (re-sealed under this server's key).
//! Every restore first keeps the current state as a backup of kind `before-restore`, so it can
//! be undone by restoring that. Preview writes nothing: it collects, compares and answers.

use super::*;
use crate::auth::{Caller, Edition, Role};
use crate::bridge::Core;
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Where the credential store's entries go in the secrets map (never a section item's path).
const STORE_PREFIX: &str = "credential-store/";
const SHARED_ITEM: &str = "shared-credential";
const TRIGGER_KEYS: [&str; 3] = ["alerts", "alertRules", "alert_rules"];

pub struct BackupState {
    dir: Option<PathBuf>,
    /// This edition keeps backups and runs the schedule (hosted).
    scheduled: bool,
    pub(crate) schedule: RwLock<Schedule>,
    /// One create-and-keep or restore at a time: two restores interleaved would each keep
    /// the other's half-written state as "before".
    pub(crate) busy: tokio::sync::Mutex<()>,
}

impl BackupState {
    pub fn open(data_dir: Option<&Path>, edition: Edition) -> BackupState {
        let dir = data_dir.map(|d| d.join(DIR));
        let schedule = dir.as_ref().and_then(|d| std::fs::read(d.join(SCHEDULE_FILE)).ok())
            .and_then(|b| serde_json::from_slice::<Schedule>(&b).map_err(|e| tracing::warn!("ignoring {DIR}/{SCHEDULE_FILE}: {e}")).ok())
            .unwrap_or_default();
        BackupState { dir, scheduled: edition.schedules(), schedule: RwLock::new(schedule), busy: Default::default() }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// Kept backups and the schedule exist here (a data directory on an edition that schedules).
    pub fn keeps(&self) -> bool {
        self.scheduled && self.dir.is_some()
    }

    /// Remove the oldest kept backups beyond `keep`, each removal audited (`backup rotated out`:
    /// the file's `name`, the `keep` it was cut to, and `user`: the administrator whose action
    /// caused it, or `system` for the timer). The one way a kept backup is pruned: a schedule
    /// change lowering `keep`, a scheduled run, a manual `keep: true` and a before-restore copy
    /// all come through here.
    pub(crate) fn prune(&self, keep: usize, by: &str) -> Vec<String> {
        let removed = self.dir.as_deref().map(|d| rotate(d, keep)).unwrap_or_default();
        for name in &removed {
            tracing::info!(target: "audit", user = %by, name = %name, keep, "backup rotated out");
        }
        removed
    }

    fn save_schedule(&self, s: &Schedule) -> Result<(), String> {
        let d = self.dir.as_ref().ok_or("no data directory")?;
        crate::volume::store::write_atomic(&d.join(SCHEDULE_FILE), &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)?;
        *self.schedule.write() = s.clone();
        Ok(())
    }

    /// Write a kept backup under `name`, or under `name` with `-2`, `-3`… when that name is taken
    /// (two backups in one second): a kept backup is never overwritten. Answers the name used.
    fn write_kept(&self, name: &str, text: &str) -> Result<String, String> {
        let d = self.dir.as_ref().ok_or("no data directory")?;
        let stem = name.strip_suffix(EXT).unwrap_or(name);
        // Above every copy made in the same second, never in a gap rotation left: a reused
        // lower number would sort as the older one and be the next rotated out.
        let taken = std::fs::read_dir(d).into_iter().flatten().filter_map(|e| e.ok())
            .filter_map(|e| {
                let n = e.file_name().to_str()?.strip_prefix(stem)?.strip_suffix(EXT)?.to_string();
                if n.is_empty() { Some(1) } else { n.strip_prefix('-')?.parse::<u32>().ok() }
            })
            .max();
        let chosen = match taken {
            None => name.to_string(),
            Some(n) => format!("{stem}-{}{EXT}", n + 1),
        };
        crate::volume::store::write_atomic(&d.join(&chosen), text.as_bytes())?;
        Ok(chosen)
    }

    fn read_kept(&self, name: &str) -> Result<String, Refusal> {
        let name = safe_name(name)?;
        let d = self.dir.as_ref().ok_or_else(|| Refusal::new("unsupported", "this server keeps no backups (no data directory)"))?;
        std::fs::read_to_string(d.join(name)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Refusal::new("not_found", format!("{name} is not a kept backup any more")),
            _ => Refusal::new("io", format!("cannot read {name}: {e}")),
        })
    }

    pub fn kept(&self) -> Vec<Kept> {
        self.dir.as_ref().map(|d| list_kept(d)).unwrap_or_default()
    }
}

fn bad(kind: &'static str, message: impl Into<String>) -> Value {
    Refusal::new(kind, message).to_json()
}

fn strip_into(v: &Value, prefix: &str, secrets: &mut BTreeMap<String, Value>) -> Value {
    let mut v = v.clone();
    strip_secrets(&mut v, prefix, secrets);
    v
}

fn without(v: &Value, keys: &[&str]) -> Value {
    let mut v = v.clone();
    if let Some(m) = v.as_object_mut() {
        for k in keys {
            m.remove(*k);
        }
    }
    v
}

/// A certificate pin as `pins.json` holds it: the SHA-256 of the DER, 64 hex characters.
fn is_cert_digest(h: &str) -> bool {
    h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())
}

/// A host-key pin as `pins.json` holds it: OpenSSH's `SHA256:<43 base64 characters>`
/// (`ssh_key::Fingerprint`), or the same digest as 64 hex characters.
fn is_hostkey_fingerprint(h: &str) -> bool {
    is_cert_digest(h)
        || h.strip_prefix("SHA256:").is_some_and(|b| b.len() == 43 && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/'))
}

fn item_prefix(section: Section, key: &str) -> String {
    format!("{}/{}", section.id(), key)
}

/// The secrets a restore may use, and how they were got: `none`, `skipped` or `opened`.
type Secrets = (Option<BTreeMap<String, Value>>, &'static str);

/// What one section's restore did.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub id: &'static str,
    pub label: &'static str,
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    /// What could not be done, said: an account not on this server, a mail password typed for
    /// another server, a managed field. Never a secret.
    pub notes: Vec<String>,
}

/// The config file as a restore sees it: the one on disk, or a new one where the server would
/// create it.
enum ConfigForRestore {
    Found(crate::bridge::LocatedConfig),
    New(crate::bridge::LocatedConfig),
}

impl Core {
    /* ----------------------------------- collecting ----------------------------------- */

    /// The config and whether it is YAML, or an empty one with a note saying why.
    async fn config_for_backup(&self) -> (Value, bool, Option<String>) {
        match self.locate_config().await {
            Ok(c) => (c.raw, c.yaml, None),
            Err(r) => {
                let kind = r["kind"].as_str().unwrap_or("");
                let note = (kind != "not_found" && kind != "no_config").then(|| format!("config file: {}", r["message"].as_str().unwrap_or("unreadable")));
                (json!({}), false, note)
            }
        }
    }

    /// Everything the ticked sections hold, from the stores that own it, secrets pulled out.
    pub(crate) async fn backup_collect(&self, sections: &[Section]) -> Collected {
        let mut out = Collected::default();
        let (raw, yaml, note) = self.config_for_backup().await;
        out.notes.extend(note);
        let hosted = self.edition() == Edition::Hosted;
        for &s in sections {
            let mut data = SectionData::default();
            match s {
                Section::Clusters => {
                    data.meta = json!({ "yaml": yaml });
                    let list = raw["clusters"].as_array().cloned().unwrap_or_default();
                    let metas = self.cluster_meta.all();
                    for (key, c) in keyed_by(&list, "", &CLUSTER_KEYS) {
                        let item = json!({ "config": c, "meta": metas.get(&key).map(|m| serde_json::to_value(m).unwrap_or(Value::Null)) });
                        data.items.insert(key.clone(), strip_into(&item, &item_prefix(s, &key), &mut out.secrets));
                    }
                    if let Some(shared) = raw.get("credentials").filter(|v| !v.is_null()) {
                        data.items.insert(SHARED_ITEM.into(), strip_into(shared, &item_prefix(s, SHARED_ITEM), &mut out.secrets));
                    }
                    if hosted {
                        let entries = self.cluster_secrets.export();
                        data.meta["credentialStore"] = json!(entries.len());
                        for (name, held, bound) in entries {
                            out.secrets.insert(format!("{STORE_PREFIX}{name}"), json!({ "user": held.user, "password": held.password, "bound": bound }));
                        }
                    }
                }
                Section::Trust => {
                    match raw.get("jump_hosts") {
                        Some(Value::Object(m)) => {
                            data.meta = json!({ "jumpShape": "map" });
                            for (k, v) in m {
                                let key = format!("jump:{k}");
                                data.items.insert(key.clone(), strip_into(v, &item_prefix(s, &key), &mut out.secrets));
                            }
                        }
                        Some(Value::Array(a)) => {
                            data.meta = json!({ "jumpShape": "list" });
                            for (key, v) in keyed(a, "jump:") {
                                data.items.insert(key.clone(), strip_into(&v, &item_prefix(s, &key), &mut out.secrets));
                            }
                        }
                        _ => data.meta = json!({ "jumpShape": "map" }),
                    }
                    let pins = self.pins.list();
                    for (kind, field) in [("cert:", "certs"), ("hostkey:", "hostkeys")] {
                        if let Some(m) = pins[field].as_object() {
                            for (k, v) in m {
                                data.items.insert(format!("{kind}{k}"), v.clone());
                            }
                        }
                    }
                    for k in self.keys.list() {
                        let key = format!("key:{}", k.name);
                        match std::fs::read_to_string(&k.path) {
                            Ok(text) => {
                                out.secrets.insert(format!("{}/text", item_prefix(s, &key)), json!(text));
                            }
                            Err(e) => out.notes.push(format!("jump-host key {}: not read ({e}); its name is in the backup, the key is not", k.name)),
                        }
                        data.items.insert(key, json!({ "name": k.name, "bytes": k.bytes, "digest": k.digest }));
                    }
                }
                Section::Alerts => {
                    let tkey = TRIGGER_KEYS.iter().find(|k| raw.get(**k).is_some()).copied();
                    data.meta = json!({ "triggersKey": tkey.unwrap_or("alerts") });
                    match tkey.map(|k| &raw[k]) {
                        Some(Value::Array(a)) => data.items.extend(keyed(a, "trigger:")),
                        Some(v) if !v.is_null() => {
                            data.items.insert("triggers".into(), v.clone());
                        }
                        _ => {}
                    }
                    if let Some(a) = raw["automations"].as_array() {
                        data.items.extend(keyed(a, "rule:"));
                    }
                }
                Section::Requests => {
                    let pol = serde_json::to_value(&*self.fleet.policy.read()).unwrap_or(Value::Null);
                    data.items.insert("policy".into(), without(&pol, &["paused"]));
                    if let Some(d) = raw.get("defaults").filter(|v| v.is_object()) {
                        data.items.insert("defaults".into(), strip_into(&without(d, &["volume"]), &item_prefix(s, "defaults"), &mut out.secrets));
                    }
                }
                Section::Zabbix => {
                    if hosted {
                        let f = self.zbx_link.file_snapshot();
                        // Built field by field: the token, the pairing secret, the pairing record
                        // and the event log never leave the server.
                        let link = json!({ "zabbixUrl": f.zabbix_url, "apiUrl": f.api_url, "verifyTls": f.verify_tls,
                                           "allowHttp": f.allow_http, "allowedSources": f.allowed_sources, "syncSecs": f.sync_secs });
                        if link.as_object().is_some_and(|m| m.values().any(|v| !v.is_null() && v != &json!(false) && v != &json!([]))) {
                            data.items.insert("link".into(), link);
                        }
                    }
                    if let Some(z) = raw.get("zabbix").filter(|v| v.is_object()) {
                        let options = without(z, &["roleMap", "role_map"]);
                        if options.as_object().is_some_and(|m| !m.is_empty()) {
                            data.items.insert("options".into(), strip_into(&options, &item_prefix(s, "options"), &mut out.secrets));
                        }
                        if let Some(rm) = z.get("roleMap").or_else(|| z.get("role_map")) {
                            data.items.insert("roleMap".into(), rm.clone());
                        }
                    }
                    if self.edition().uses_accounts() {
                        for a in self.users.list() {
                            if a.source.is_some() && a.role_pinned {
                                data.items.insert(format!("role:{}", a.name), json!({ "role": a.role, "noAccess": a.no_access }));
                            }
                        }
                    }
                }
                Section::Reports => {
                    let mail: crate::report::mail::MailFile = self.reports.read_json(crate::report::mail::FILE);
                    if !mail.host.is_empty() || !mail.from.is_empty() {
                        if let (Some(sealed), Some(dest)) = (&mail.password, &mail.password_for) {
                            match self.cluster_secrets.open_own(&crate::report::mail::seal_aad(dest), sealed) {
                                Some(pw) => {
                                    out.secrets.insert(format!("{}/password", item_prefix(s, "mail")), json!({ "password": pw, "for": dest }));
                                }
                                None => out.notes.push("mail: the stored SMTP password does not open with this server's key; left out".into()),
                            }
                        }
                        let v = serde_json::to_value(&mail).unwrap_or(Value::Null);
                        data.items.insert("mail".into(), without(&v, &["password", "passwordFor"]));
                    }
                    let sched = serde_json::to_value(self.reports.schedule_settings()).unwrap_or(Value::Null);
                    if sched.as_object().is_some_and(|m| !m.is_empty()) {
                        data.items.insert("schedules".into(), sched);
                    }
                    if let Some(templates) = self.plan_templates.kept() {
                        data.meta = json!({ "customTemplates": true });
                        data.items.extend(keyed(&templates, "template:"));
                    }
                    if let Some(vol) = raw.pointer("/defaults/volume").filter(|v| !v.is_null()) {
                        data.items.insert("volume".into(), vol.clone());
                    }
                }
                Section::Play => {
                    let st = serde_json::to_value(&*self.play.settings.read()).unwrap_or(Value::Null);
                    for (item, field) in [("watch", "watch"), ("exclude", "exclude"), ("defaultDisplay", "defaultDisplay")] {
                        if let Some(v) = st.get(field) {
                            data.items.insert(item.into(), v.clone());
                        }
                    }
                    if let Some(m) = st["displays"].as_object() {
                        for (k, v) in m {
                            data.items.insert(format!("display:{k}"), v.clone());
                        }
                    }
                }
                Section::Data => {
                    if self.history_store.supported() {
                        let st = self.history_store.stored.read().clone();
                        if st.configured() {
                            if let Some(sealed) = &st.sealed {
                                let kind = st.sealed_auth.unwrap_or(st.auth);
                                match self.cluster_secrets.open_own(&crate::history_store::seal_aad(&st.sealed_for, kind), sealed) {
                                    Some(secret) => {
                                        out.secrets.insert(format!("{}/secret", item_prefix(s, "historyStore")),
                                                           json!({ "secret": secret, "for": st.sealed_for, "auth": kind }));
                                    }
                                    None => out.notes.push("history store: the stored secret does not open with this server's key; left out".into()),
                                }
                            }
                            data.items.insert("historyStore".into(), json!({
                                "url": st.url, "auth": st.auth, "user": st.user, "tls": st.tls, "via": st.via,
                                "prefix": st.prefix, "streams": st.streams }));
                        }
                    }
                    if self.edition().schedules() {
                        let cfg = serde_json::to_value(self.delay_sink_config()).unwrap_or(Value::Null);
                        data.items.insert("logDelay".into(), without(&cfg, &["enabled"]));
                    }
                }
                Section::Versions => {
                    for v in self.history.list() {
                        let Ok(text) = self.history.read(&v.id) else { continue };
                        let yaml = !text.trim_start_matches('\u{feff}').trim_start().starts_with('{');
                        match crate::bridge::parse_config_text(&text) {
                            Ok(mut parsed) => {
                                // Redacted the same way as the live config, and the secrets discarded:
                                // an old version's credentials are not what a restore brings back.
                                let mut discard = BTreeMap::new();
                                strip_secrets(&mut parsed, "", &mut discard);
                                data.items.insert(format!("version:{}", v.id), json!({
                                    "id": v.id, "savedAt": v.saved_at, "savedBy": v.saved_by, "summary": v.summary,
                                    "source": v.source, "text": crate::bridge::serialize_config(&parsed, yaml) }));
                            }
                            Err(_) => out.notes.push(format!("config version {}: does not parse, so it could not be redacted; left out", v.id)),
                        }
                    }
                }
            }
            out.sections.insert(s, data);
        }
        out
    }

    /* -------------------------------------- making -------------------------------------- */

    fn server_sealer(&self) -> Option<impl Fn(&str, &str) -> Result<String, String> + '_> {
        self.cluster_secrets.can_seal_own().ok()?;
        Some(move |aad: &str, plain: &str| self.cluster_secrets.seal_blob(aad, plain))
    }

    /// A backup as text. `password`: the admin's, so the credentials go in sealed with it;
    /// `server_sealed`: for a backup that stays here, sealed under this server's key; neither:
    /// no credentials in the file.
    async fn backup_text(&self, sections: &[Section], kind: Kind, by: &str, password: Option<&str>, server_sealed: bool)
        -> Result<(String, Collected, &'static str), Refusal> {
        let collected = self.backup_collect(sections).await;
        let header = Header { core_version: crate::VERSION, taken_at: crate::fleet::now_ms(), taken_by: by, kind };
        let server = self.server_sealer();
        let (sealer, scheme) = match (password, server_sealed, &server) {
            (Some(pw), _, _) => (Some(Sealer::Password(pw)), "password"),
            (None, true, Some(seal)) => (Some(Sealer::Server(seal)), "server"),
            // A copy kept on this server must carry its credentials sealed: one kept without
            // them would look like a backup and restore as none. Refused, with the reason.
            (None, true, None) => return Err(Refusal::new("no_server_key", format!(
                "this server has no key to seal a kept backup's credentials with: {}",
                self.cluster_secrets.can_seal_own().err().unwrap_or_default()))),
            (None, false, _) => (None, "none"),
        };
        let text = build(&header, &collected, sealer)?;
        Ok((text, collected, scheme))
    }

    /// Make a backup and keep it in `backups/`, named for `local` (when it was asked for), rotating
    /// to `keep`. Answers the file name.
    async fn backup_keep(&self, sections: &[Section], kind: Kind, by: &str, keep: usize, local: chrono::NaiveDateTime)
        -> Result<(String, u64, usize), Refusal> {
        if !self.backup.keeps() {
            return Err(Refusal::new("unsupported", "this edition keeps no backups on the server: download one instead"));
        }
        let (text, collected, _) = self.backup_text(sections, kind, by, None, true).await?;
        let name = self.backup.write_kept(&file_name(local, kind), &text).map_err(|e| Refusal::new("io", format!("the backup could not be written: {e}")))?;
        self.backup.prune(keep, by);
        Ok((name, text.len() as u64, collected.secrets.len()))
    }

    /* ------------------------------------- restoring ------------------------------------- */

    async fn config_for_restore(&self) -> Result<ConfigForRestore, Refusal> {
        match self.locate_config().await {
            Ok(c) => Ok(ConfigForRestore::Found(c)),
            Err(r) => match r["kind"].as_str().unwrap_or("") {
                "not_found" | "no_config" => {
                    let path = self.server_config_path().ok_or_else(|| Refusal::new("no_config", "this server has no config file and no data directory to create one in"))?;
                    Ok(ConfigForRestore::New(crate::bridge::LocatedConfig { path, yaml: false, raw: json!({ "version": 1 }) }))
                }
                _ => Err(Refusal::new("io", r["message"].as_str().unwrap_or("the config file cannot be read").to_string())),
            },
        }
    }

    /// Apply `parsed` as `mode`, the ticked `sections` only, with `secrets` when the credentials
    /// were opened. Counts come from the same comparison the preview showed (`removed` is the
    /// preview's `only_here`: what `Section::replace_removes` says a Replace takes away, and no
    /// more); `notes` say what a store would not take. In Merge, a credential the backup did not
    /// bring is filled from what this server holds (`restore_secrets_missing`), so a merge never
    /// removes one. The config is changed in memory first and written once.
    pub(crate) async fn backup_apply(self: &Arc<Self>, parsed: &Parsed, secrets: Option<&BTreeMap<String, Value>>, mode: Mode,
                                     sections: &[Section], by: &str) -> Result<Vec<Applied>, Refusal> {
        let current = self.backup_collect(sections).await;
        let previews = preview(&current, &parsed.sections, sections);
        let mut applied: Vec<Applied> = previews.iter().map(|p| Applied {
            id: p.id, label: p.label, added: p.add.len(), changed: p.change.len(),
            removed: if mode == Mode::Replace { p.only_here.len() } else { 0 }, notes: vec![] }).collect();
        let note = |applied: &mut Vec<Applied>, s: Section, text: String| {
            if let Some(a) = applied.iter_mut().find(|a| a.id == s.id()) {
                a.notes.push(text);
            }
        };
        let empty = BTreeMap::new();
        let secrets_or_empty = secrets.unwrap_or(&empty);
        let hosted = self.edition() == Edition::Hosted;
        let now = crate::fleet::now_ms();
        let config_sections = [Section::Clusters, Section::Trust, Section::Alerts, Section::Requests, Section::Zabbix, Section::Reports];
        let touches_config = sections.iter().any(|s| config_sections.contains(s) && parsed.sections.contains_key(s));

        // 1. The config file, in memory.
        let mut found = match self.config_for_restore().await? {
            ConfigForRestore::Found(c) | ConfigForRestore::New(c) => c,
        };
        if touches_config {
            let raw = &mut found.raw;
            if !raw.is_object() {
                return Err(Refusal::new("parse_error", "the config file is not a JSON/YAML object"));
            }
            for &s in sections {
                let Some(inc) = parsed.sections.get(&s) else { continue };
                match s {
                    Section::Clusters => {
                        let mut configs = BTreeMap::new();
                        for (key, item) in &inc.items {
                            if key == SHARED_ITEM {
                                continue;
                            }
                            let mut item = item.clone();
                            restore_secrets(&mut item, &item_prefix(s, key), secrets_or_empty);
                            if mode == Mode::Merge {
                                // A merge never costs a cluster the password it has here: what
                                // the backup did not bring (no password typed, or an older file)
                                // is filled from what this server holds now.
                                restore_secrets_missing(&mut item, &item_prefix(s, key), &current.secrets);
                            }
                            if let Some(c) = item.get("config").filter(|c| c.is_object()) {
                                configs.insert(key.clone(), c.clone());
                            }
                        }
                        let existing = raw["clusters"].as_array().cloned().unwrap_or_default();
                        raw["clusters"] = json!(merge_list_by(&existing, &configs, "", &CLUSTER_KEYS, mode));
                        match inc.items.get(SHARED_ITEM) {
                            Some(shared) => {
                                let mut shared = shared.clone();
                                restore_secrets(&mut shared, &item_prefix(s, SHARED_ITEM), secrets_or_empty);
                                if mode == Mode::Merge {
                                    restore_secrets_missing(&mut shared, &item_prefix(s, SHARED_ITEM), &current.secrets);
                                }
                                raw["credentials"] = merge_object(raw.get("credentials").unwrap_or(&Value::Null), &shared, mode);
                            }
                            None if mode == Mode::Replace => {
                                raw.as_object_mut().map(|m| m.remove("credentials"));
                            }
                            None => {}
                        }
                        if secrets.is_none() && (parsed.credentials.is_some() || !inc.items.is_empty()) {
                            note(&mut applied, s, if mode == Mode::Merge {
                                "no credentials came with the backup: the ones this server holds were kept".into()
                            } else {
                                "credentials were not restored: the clusters will ask for them again".into()
                            });
                        }
                    }
                    Section::Trust => {
                        let jumps: BTreeMap<String, Value> = inc.items.iter().filter(|(k, _)| k.starts_with("jump:")).map(|(k, v)| {
                            let mut v = v.clone();
                            restore_secrets(&mut v, &item_prefix(s, k), secrets_or_empty);
                            if mode == Mode::Merge {
                                restore_secrets_missing(&mut v, &item_prefix(s, k), &current.secrets);
                            }
                            (k.clone(), v)
                        }).collect();
                        if !jumps.is_empty() || mode == Mode::Replace {
                            match raw.get("jump_hosts") {
                                Some(Value::Array(a)) => {
                                    raw["jump_hosts"] = json!(merge_list(a, &jumps, "jump:", mode));
                                }
                                other => {
                                    let cur: BTreeMap<String, Value> = other.and_then(Value::as_object)
                                        .map(|m| m.iter().map(|(k, v)| (format!("jump:{k}"), v.clone())).collect()).unwrap_or_default();
                                    let merged = merge_items(&cur, &jumps, mode);
                                    if inc.meta["jumpShape"] == "list" && other.is_none() {
                                        raw["jump_hosts"] = json!(merged.values().cloned().collect::<Vec<_>>());
                                    } else {
                                        let m: serde_json::Map<String, Value> = merged.into_iter().map(|(k, v)| (k.trim_start_matches("jump:").to_string(), v)).collect();
                                        raw["jump_hosts"] = Value::Object(m);
                                    }
                                }
                            }
                        }
                    }
                    Section::Alerts => {
                        let tkey = inc.meta["triggersKey"].as_str().filter(|k| TRIGGER_KEYS.contains(k))
                            .or_else(|| TRIGGER_KEYS.iter().find(|k| raw.get(**k).is_some()).copied()).unwrap_or("alerts");
                        if let Some(t) = inc.items.get("triggers") {
                            raw[tkey] = merge_object(raw.get(tkey).unwrap_or(&Value::Null), t, mode);
                        } else {
                            let triggers: BTreeMap<String, Value> = inc.items.iter().filter(|(k, _)| k.starts_with("trigger:")).map(|(k, v)| (k.clone(), v.clone())).collect();
                            if !triggers.is_empty() || mode == Mode::Replace {
                                let existing = raw.get(tkey).and_then(Value::as_array).cloned().unwrap_or_default();
                                raw[tkey] = json!(merge_list(&existing, &triggers, "trigger:", mode));
                            }
                        }
                        let rules: BTreeMap<String, Value> = inc.items.iter().filter(|(k, _)| k.starts_with("rule:")).map(|(k, v)| (k.clone(), v.clone())).collect();
                        if !rules.is_empty() || mode == Mode::Replace {
                            let existing = raw["automations"].as_array().cloned().unwrap_or_default();
                            let list = json!(merge_list(&existing, &rules, "rule:", mode));
                            crate::cluster_save::apply_automations(raw, &list).map_err(|r| Refusal::new("bad_request", format!("automation rules: {}", r.message)))?;
                        }
                    }
                    Section::Requests => {
                        if let Some(d) = inc.items.get("defaults") {
                            let mut d = d.clone();
                            restore_secrets(&mut d, &item_prefix(s, "defaults"), secrets_or_empty);
                            if mode == Mode::Merge {
                                restore_secrets_missing(&mut d, &item_prefix(s, "defaults"), &current.secrets);
                            }
                            let volume = raw.pointer("/defaults/volume").cloned();
                            let mut next = merge_object(&without(raw.get("defaults").unwrap_or(&Value::Null), &["volume"]), &d, mode);
                            if let Some(v) = volume {
                                next["volume"] = v;
                            }
                            raw["defaults"] = next;
                        }
                    }
                    Section::Zabbix => {
                        let has_options = inc.items.contains_key("options");
                        let has_map = inc.items.contains_key("roleMap");
                        if has_options || has_map || mode == Mode::Replace {
                            let cur = raw.get("zabbix").cloned().unwrap_or(Value::Null);
                            let cur_map = cur.get("roleMap").or_else(|| cur.get("role_map")).cloned();
                            let mut next = match inc.items.get("options") {
                                Some(o) => {
                                    let mut o = o.clone();
                                    restore_secrets(&mut o, &item_prefix(s, "options"), secrets_or_empty);
                                    if mode == Mode::Merge {
                                        restore_secrets_missing(&mut o, &item_prefix(s, "options"), &current.secrets);
                                    }
                                    merge_object(&without(&cur, &["roleMap", "role_map"]), &o, mode)
                                }
                                None if mode == Mode::Replace => json!({}),
                                None => without(&cur, &["roleMap", "role_map"]),
                            };
                            if !next.is_object() {
                                next = json!({});
                            }
                            if let Some(m) = inc.items.get("roleMap").cloned().or(if mode == Mode::Merge { cur_map } else { None }) {
                                next["roleMap"] = m;
                            }
                            raw["zabbix"] = next;
                        }
                    }
                    Section::Reports => {
                        match inc.items.get("volume") {
                            Some(v) => {
                                let cur = raw.pointer("/defaults/volume").cloned().unwrap_or(Value::Null);
                                if !raw["defaults"].is_object() {
                                    raw["defaults"] = json!({});
                                }
                                raw["defaults"]["volume"] = merge_object(&cur, v, mode);
                            }
                            None if mode == Mode::Replace => {
                                if let Some(d) = raw["defaults"].as_object_mut() {
                                    d.remove("volume");
                                }
                            }
                            None => {}
                        }
                    }
                    _ => {}
                }
            }
            // 2. Written once, through the same door as every other config save: a version of
            // what was there is kept, and the record says who restored and what changed.
            self.store_config(&found, by).await.map_err(|r| Refusal::new("io", r["message"].as_str().unwrap_or("the config could not be written").to_string()))?;
        }

        // 3. The stores with setters of their own.
        for &s in sections {
            let Some(inc) = parsed.sections.get(&s) else { continue };
            match s {
                Section::Clusters => {
                    // Cluster type and ULM bucket.
                    let metas = self.cluster_meta.all();
                    for (key, item) in &inc.items {
                        if key == SHARED_ITEM {
                            continue;
                        }
                        match item.get("meta").filter(|m| !m.is_null()).map(|m| serde_json::from_value::<crate::cluster_meta::Meta>(m.clone())) {
                            Some(Ok(m)) => {
                                if let Err(e) = self.cluster_meta.set(key, Some(m)) {
                                    note(&mut applied, s, format!("{key}: cluster type not kept ({e})"));
                                }
                            }
                            Some(Err(e)) => note(&mut applied, s, format!("{key}: cluster type not understood ({e})")),
                            None => {}
                        }
                    }
                    if mode == Mode::Replace {
                        for k in metas.keys() {
                            if !inc.items.contains_key(k) {
                                let _ = self.cluster_meta.set(k, None);
                            }
                        }
                    }
                    // Credentials kept on the server, re-sealed under this server's key.
                    if hosted {
                        if let Some(secrets) = secrets {
                            let mut restored = std::collections::HashSet::new();
                            for (path, v) in secrets.iter().filter(|(p, _)| p.starts_with(STORE_PREFIX)) {
                                let name = &path[STORE_PREFIX.len()..];
                                let (user, pw, bound) = (v["user"].as_str().unwrap_or(""), v["password"].as_str().unwrap_or(""), v["bound"].as_str().unwrap_or(""));
                                match self.cluster_secrets.set_bound(name, user, pw, bound, by, now) {
                                    Ok(()) => {
                                        restored.insert(name.to_string());
                                    }
                                    Err(e) => note(&mut applied, s, format!("credential {name}: not kept ({e})")),
                                }
                            }
                            if mode == Mode::Replace {
                                for e in self.cluster_secrets.list() {
                                    if !restored.contains(&e.name) {
                                        let _ = self.cluster_secrets.remove(&e.name);
                                    }
                                }
                            }
                            if !restored.is_empty() {
                                note(&mut applied, s, format!("{} server-kept credential(s) re-sealed under this server's key", restored.len()));
                            }
                        }
                    }
                }
                Section::Trust => {
                    let pins = self.pins.list();
                    for (key, v) in &inc.items {
                        if let Some(host) = key.strip_prefix("cert:") {
                            match v["sha256"].as_str().filter(|h| is_cert_digest(h)) {
                                Some(h) => self.pins.trust_cert(host, h, v["subject"].as_str().unwrap_or("")),
                                None => note(&mut applied, s, format!("{key}: not a SHA-256 certificate digest (64 hex characters); skipped")),
                            }
                        } else if let Some(j) = key.strip_prefix("hostkey:") {
                            match v["sha256"].as_str().filter(|h| is_hostkey_fingerprint(h)) {
                                Some(h) => self.pins.trust_hostkey(j, h, v["subject"].as_str().unwrap_or("")),
                                None => note(&mut applied, s, format!("{key}: not a SHA-256 host-key fingerprint; skipped")),
                            }
                        } else if let Some(name) = key.strip_prefix("key:") {
                            match secrets_or_empty.get(&format!("{}/text", item_prefix(s, key))).and_then(Value::as_str) {
                                Some(text) => {
                                    if let Err(e) = self.keys.put(name, text) {
                                        note(&mut applied, s, format!("jump-host key {name}: not kept ({e})"));
                                    }
                                }
                                None => note(&mut applied, s, format!("jump-host key {name}: not in this backup's credentials; upload it again")),
                            }
                        }
                    }
                    if mode == Mode::Replace {
                        for (kind, field) in [("cert:", "certs"), ("hostkey:", "hostkeys")] {
                            for k in pins[field].as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
                                if !inc.items.contains_key(&format!("{kind}{k}")) {
                                    if kind == "cert:" { self.pins.untrust_cert(&k) } else { self.pins.untrust_hostkey(&k) }
                                }
                            }
                        }
                        for k in self.keys.list() {
                            if !inc.items.contains_key(&format!("key:{}", k.name)) {
                                let _ = self.keys.delete(&k.name);
                            }
                        }
                    }
                }
                Section::Requests => {
                    if let Some(p) = inc.items.get("policy") {
                        let cur = serde_json::to_value(&*self.fleet.policy.read()).unwrap_or(Value::Null);
                        let merged = merge_object(&without(&cur, &["paused"]), p, mode);
                        match self.policy_apply(merged) {
                            Ok((_, Err(e))) => note(&mut applied, s, format!("request policy applied but not written: {e}")),
                            Ok(_) => {}
                            Err(r) => note(&mut applied, s, format!("request policy: {}", r["message"].as_str().unwrap_or("refused"))),
                        }
                    }
                }
                Section::Zabbix => {
                    if let Some(link) = inc.items.get("link") {
                        if hosted {
                            let mut msg = link.clone();
                            if let Some(m) = msg.as_object_mut() {
                                // Never from a backup, whatever the file says.
                                m.remove("apiToken");
                                m.remove("ssoSecret");
                                m.retain(|_, v| !v.is_null());
                            }
                            let had_token = self.zbx_link.file_snapshot().api_token.is_some();
                            match self.zbx_link.set(&msg, by, now) {
                                Ok((_, api)) => {
                                    if api {
                                        self.apply_link();
                                        self.sync_soon();
                                    }
                                    note(&mut applied, s, if had_token {
                                        "Zabbix connection restored; the API token this server already holds was kept (a backup never carries one)".into()
                                    } else {
                                        "Zabbix connection restored without an API token (a backup never carries one): pair again".into()
                                    });
                                }
                                Err(e) => note(&mut applied, s, format!("Zabbix connection: {e}")),
                            }
                        } else {
                            note(&mut applied, s, "Zabbix connection settings are a hosted server's; skipped".into());
                        }
                    }
                    if self.edition().uses_accounts() {
                        let pinned_now: Vec<String> = self.users.list().into_iter().filter(|a| a.source.is_some() && a.role_pinned).map(|a| a.name).collect();
                        for (key, v) in &inc.items {
                            let Some(name) = key.strip_prefix("role:") else { continue };
                            let target = if v["noAccess"].as_bool().unwrap_or(false) {
                                None
                            } else {
                                match v["role"].as_str().and_then(Role::parse) {
                                    Some(role) => Some(role),
                                    None => {
                                        note(&mut applied, s, format!("{name}: role {:?} not understood", v["role"]));
                                        continue;
                                    }
                                }
                            };
                            // The same door USER_SET_ROLE uses: never one's own administrator
                            // role, No access only for an account another system signs in,
                            // open sessions refreshed or ended.
                            if let Err(refusal) = self.apply_role(name, target, by) {
                                note(&mut applied, s, format!("{name}: role not set ({}) — the person signs in from Zabbix first",
                                                              refusal["message"].as_str().unwrap_or("refused")));
                            }
                        }
                        if mode == Mode::Replace {
                            for name in pinned_now {
                                if !inc.items.contains_key(&format!("role:{name}")) {
                                    if let Err(e) = self.users.unpin_role(&name) {
                                        note(&mut applied, s, format!("{name}: pin not lifted ({e})"));
                                        if let Some(a) = applied.iter_mut().find(|a| a.id == s.id()) {
                                            a.removed = a.removed.saturating_sub(1);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Section::Reports => {
                    if let Some(m) = inc.items.get("mail") {
                        use crate::report::mail;
                        let _one = self.reports.settings_lock.lock();
                        let cur: mail::MailFile = self.reports.read_json(mail::FILE);
                        let cur_v = serde_json::to_value(&cur).unwrap_or(Value::Null);
                        let merged = merge_object(&without(&cur_v, &["password", "passwordFor"]), m, mode);
                        match serde_json::from_value::<mail::MailFile>(merged) {
                            Ok(mut next) => {
                                let dest = mail::destination(&next.host, next.port.unwrap_or(0), next.security, &next.user);
                                match secrets_or_empty.get(&format!("{}/password", item_prefix(s, "mail"))) {
                                    Some(sec) if sec["for"].as_str() == Some(dest.as_str()) => {
                                        match self.cluster_secrets.seal_own(&mail::seal_aad(&dest), sec["password"].as_str().unwrap_or("")) {
                                            Ok(sealed) => {
                                                next.password = Some(sealed);
                                                next.password_for = Some(dest);
                                            }
                                            Err(e) => note(&mut applied, s, format!("mail password not kept: {e}")),
                                        }
                                    }
                                    Some(_) => note(&mut applied, s, "mail: the password in the backup was typed for another server; type it again".into()),
                                    None if mode == Mode::Merge && cur.password_for.as_deref() == Some(dest.as_str()) => {
                                        next.password = cur.password.clone();
                                        next.password_for = cur.password_for.clone();
                                    }
                                    None => {
                                        if cur.password.is_some() || parsed.credentials.is_some() {
                                            note(&mut applied, s, "mail: no password restored; type it again".into());
                                        }
                                    }
                                }
                                if let Err(e) = self.reports.write_json(mail::FILE, &next) {
                                    note(&mut applied, s, format!("mail settings not written: {e}"));
                                }
                            }
                            Err(e) => note(&mut applied, s, format!("mail settings not understood: {e}")),
                        }
                    }
                    if let Some(sch) = inc.items.get("schedules") {
                        let _one = self.reports.settings_lock.lock();
                        let cur = serde_json::to_value(self.reports.schedule_settings()).unwrap_or(Value::Null);
                        let next = crate::report::schedule::ScheduleFile::from_value(&merge_object(&cur, sch, mode));
                        if let Err(e) = self.reports.write_schedule_settings(&next) {
                            note(&mut applied, s, format!("report schedules not written: {e}"));
                        }
                    }
                    let templates: BTreeMap<String, Value> = inc.items.iter().filter(|(k, _)| k.starts_with("template:")).map(|(k, v)| (k.clone(), v.clone())).collect();
                    if !templates.is_empty() || (mode == Mode::Replace && inc.meta["customTemplates"] == true) {
                        let existing = self.plan_templates.kept().unwrap_or_else(crate::plan_templates::seed);
                        let list = json!(merge_list(&existing, &templates, "template:", mode));
                        match crate::plan_templates::PlanTemplates::check(&list) {
                            Ok(list) => {
                                if let Err(e) = self.plan_templates.replace(list, by, now) {
                                    note(&mut applied, s, format!("plan templates not kept: {e}"));
                                }
                            }
                            Err(e) => note(&mut applied, s, format!("plan templates: {e}")),
                        }
                    }
                }
                Section::Play => {
                    let mut patch = serde_json::Map::new();
                    for (item, field) in [("watch", "watch"), ("exclude", "exclude"), ("defaultDisplay", "defaultDisplay")] {
                        if let Some(v) = inc.items.get(item) {
                            patch.insert(field.into(), v.clone());
                        }
                    }
                    let displays: serde_json::Map<String, Value> = inc.items.iter().filter_map(|(k, v)| k.strip_prefix("display:").map(|id| (id.to_string(), v.clone()))).collect();
                    if !displays.is_empty() {
                        patch.insert("displays".into(), Value::Object(displays.clone()));
                    }
                    if !patch.is_empty() || mode == Mode::Replace {
                        let _one = self.play.edit.lock();
                        let current = self.play.settings.read().clone();
                        match crate::play::settings::apply_change(&current, &Value::Object(patch), crate::settings::get(), by, now) {
                            Ok(mut next) => {
                                if mode == Mode::Replace {
                                    next.displays.retain(|k, _| displays.contains_key(k));
                                    if !inc.items.contains_key("exclude") {
                                        next.exclude.clear();
                                    }
                                }
                                if let Err(e) = self.play.save_settings(&next) {
                                    note(&mut applied, s, format!("Play settings not written: {e}"));
                                }
                            }
                            Err(e) => note(&mut applied, s, format!("Play settings: {e}")),
                        }
                    }
                }
                Section::Data => {
                    if let Some(h) = inc.items.get("historyStore") {
                        if self.history_store.supported() {
                            let secret = secrets_or_empty.get(&format!("{}/secret", item_prefix(s, "historyStore"))).cloned();
                            let r = self.history_store.update(|st| {
                                let cur = json!({ "url": st.url, "auth": st.auth, "user": st.user, "tls": st.tls, "via": st.via, "prefix": st.prefix, "streams": st.streams });
                                let m = merge_object(&cur, h, mode);
                                st.url = m["url"].as_str().unwrap_or("").to_string();
                                st.auth = serde_json::from_value(m["auth"].clone()).unwrap_or_default();
                                st.user = m["user"].as_str().unwrap_or("").to_string();
                                st.tls = m["tls"].as_str().unwrap_or("").to_string();
                                st.via = m["via"].as_str().unwrap_or("").to_string();
                                st.prefix = m["prefix"].as_str().unwrap_or("").to_string();
                                st.streams = serde_json::from_value(m["streams"].clone()).unwrap_or_default();
                                let dest = st.destination();
                                let kind = st.auth;
                                match &secret {
                                    Some(sec) if sec["for"].as_str() == Some(dest.as_str()) && serde_json::from_value::<crate::history_store::AuthKind>(sec["auth"].clone()).ok() == Some(kind) => {
                                        st.sealed = Some(self.cluster_secrets.seal_own(&crate::history_store::seal_aad(&dest, kind), sec["secret"].as_str().unwrap_or(""))?);
                                        st.sealed_for = dest;
                                        st.sealed_auth = Some(kind);
                                    }
                                    _ if st.sealed_for != dest || st.sealed_auth != Some(kind) => {
                                        st.sealed = None;
                                        st.sealed_for = String::new();
                                        st.sealed_auth = None;
                                    }
                                    _ => {}
                                }
                                // A restored store is never armed: the two gates are taken again.
                                st.armed = false;
                                st.armed_by = None;
                                st.armed_at = None;
                                st.test = None;
                                Ok(())
                            });
                            match r {
                                Ok(st) => {
                                    if st.sealed.is_none() && st.configured() && st.auth != crate::history_store::AuthKind::None {
                                        note(&mut applied, s, "history store: no secret restored; type it again".into());
                                    }
                                    note(&mut applied, s, "history store restored disarmed: test and arm it again".into());
                                }
                                Err(e) => note(&mut applied, s, format!("history store: {e}")),
                            }
                        } else {
                            note(&mut applied, s, "history store settings are a hosted server's; skipped".into());
                        }
                    }
                    if let Some(d) = inc.items.get("logDelay") {
                        if self.edition().schedules() {
                            let cur = serde_json::to_value(self.delay_sink_config()).unwrap_or(Value::Null);
                            let mut merged = merge_object(&cur, d, mode);
                            merged["enabled"] = json!(false);
                            match serde_json::from_value::<crate::delay_sink::SinkConfig>(merged).map(|c| c.normalised()) {
                                Ok(cfg) => match cfg.refusal() {
                                    Some(why) => note(&mut applied, s, format!("scheduled log delay: {why}")),
                                    None => match self.set_delay_sink_config(cfg) {
                                        Ok(()) => note(&mut applied, s, "scheduled log delay restored disarmed: arm it again".into()),
                                        Err(e) => note(&mut applied, s, format!("scheduled log delay: {e}")),
                                    },
                                },
                                Err(e) => note(&mut applied, s, format!("scheduled log delay settings not understood: {e}")),
                            }
                        } else {
                            note(&mut applied, s, "scheduled log delay is a hosted server's; skipped".into());
                        }
                    }
                }
                Section::Versions => {
                    let mut n = 0;
                    for v in inc.items.values() {
                        let (Some(id), Some(text)) = (v["id"].as_str(), v["text"].as_str()) else { continue };
                        match self.history.import(id, text, v["savedBy"].as_str(), v["summary"].as_str()) {
                            Ok(true) => n += 1,
                            Ok(false) => {}
                            Err(e) => note(&mut applied, s, format!("version {id}: {e}")),
                        }
                    }
                    if let Some(a) = applied.iter_mut().find(|a| a.id == s.id()) {
                        // Versions are only ever added; history is not rewritten or trimmed by a restore.
                        a.added = n;
                        a.changed = 0;
                        a.removed = 0;
                    }
                }
                Section::Alerts => {}
            }
        }
        Ok(applied)
    }

    /* -------------------------------------- messages -------------------------------------- */

    fn backup_status(&self) -> Value {
        let s = self.backup.schedule.read().clone();
        let local = crate::volume::schedule::local_now();
        let next = s.next_run(local).and_then(crate::volume::schedule::local_to_ms);
        json!({
            "ok": true,
            "supported": true,
            "keeps": self.backup.keeps(),
            "dir": self.backup.dir().map(|d| d.display().to_string()),
            "serverSealing": self.cluster_secrets.can_seal_own().is_ok(),
            "minPassword": MIN_PASSWORD,
            "sections": Section::ALL.iter().map(|s| json!({ "id": s.id(), "label": s.label() })).collect::<Vec<_>>(),
            "schedule": { "enabled": s.enabled, "every": s.every, "at": s.at, "keep": s.keep,
                          "sections": s.sections.iter().map(|x| x.id()).collect::<Vec<_>>(), "last": s.last, "next": next,
                          "keepMax": MAX_KEEP },
            "kept": if self.backup.keeps() { json!(self.backup.kept()) } else { json!([]) },
        })
    }

    /// The file a message names: uploaded text (`file`) or a kept backup (`name`).
    fn backup_source(&self, msg: &Value) -> Result<(String, Option<String>), Refusal> {
        if let Some(text) = msg.get("file").and_then(Value::as_str) {
            return Ok((text.to_string(), None));
        }
        if let Some(name) = msg.get("name").and_then(Value::as_str) {
            return Ok((self.backup.read_kept(name)?, Some(name.to_string())));
        }
        Err(Refusal::new("bad_request", "file (the backup's text) or name (a kept backup)"))
    }

    /// Open the credentials with what the message offers: the password it carries, else this
    /// server's key for a server-sealed file. Refusals as `open_credentials` gives them, except
    /// `skipCredentials: true`, which restores the settings alone.
    fn backup_secrets(&self, parsed: &Parsed, msg: &Value) -> Result<Secrets, Refusal> {
        if parsed.credentials.is_none() {
            return Ok((None, "none"));
        }
        if msg.get("skipCredentials").and_then(Value::as_bool).unwrap_or(false) {
            return Ok((None, "skipped"));
        }
        let password = msg.get("password").and_then(Value::as_str).filter(|p| !p.is_empty());
        let open_server = |aad: &str, sealed: &str| self.cluster_secrets.open_own(aad, sealed);
        let scheme = parsed.credentials.as_ref().map(|c| c.scheme.as_str()).unwrap_or("");
        let opener = match (scheme, password) {
            ("password", Some(pw)) => Some(Opener::Password(pw)),
            ("password", None) => None,
            _ => Some(Opener::Server(&open_server)),
        };
        open_credentials(parsed, opener).map(|s| (s, "opened"))
    }

    /// `BACKUP_*` (docs/HANDBOOK.md "Backup and restore — the message contract"). Administrators
    /// who see every cluster: a backup holds every cluster and the server's own settings.
    pub(crate) async fn backup_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        if caller.is_some_and(|c| c.role < Role::Admin || c.limited()) {
            return bad("forbidden", "backups hold every cluster and the server's settings: they need an administrator who sees every cluster");
        }
        let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| self.saver_name(None));
        match t {
            "BACKUP_STATUS" => self.backup_status(),
            "BACKUP_CREATE" => {
                let sections = match Section::from_message(msg.get("sections")) {
                    Ok(s) => s,
                    Err(e) => return bad("bad_request", e),
                };
                let password = msg.get("password").and_then(Value::as_str).filter(|p| !p.is_empty());
                if let Some(pw) = password {
                    if let Err(r) = check_password(pw) {
                        return r.to_json();
                    }
                }
                let keep = msg.get("keep").and_then(Value::as_bool).unwrap_or(false);
                if keep && !self.backup.keeps() {
                    return bad("unsupported", "this edition keeps no backups on the server: download it instead");
                }
                let _one = self.backup.busy.lock().await;
                let (text, collected, scheme) = match self.backup_text(&sections, Kind::Manual, &by, password, false).await {
                    Ok(x) => x,
                    Err(r) => return r.to_json(),
                };
                let mut name = file_name(crate::volume::schedule::local_now(), Kind::Manual);
                let mut kept = false;
                if keep {
                    // Kept with the credentials under the server's key, like a scheduled one — a
                    // file on this server is readable by this server; the download carries the
                    // password-sealed text the admin asked for.
                    let server_text = match self.backup_text(&sections, Kind::Manual, &by, None, true).await {
                        Ok((t, _, _)) => t,
                        Err(r) => return r.to_json(),
                    };
                    match self.backup.write_kept(&name, &server_text) {
                        Ok(n) => name = n,
                        Err(e) => return bad("io", format!("the backup could not be kept: {e}")),
                    }
                    let keep_n = self.backup.schedule.read().keep;
                    self.backup.prune(keep_n, &by);
                    kept = true;
                }
                tracing::info!(target: "audit", user = %by, kind = "manual", sections = %sections.iter().map(|s| s.id()).collect::<Vec<_>>().join(","),
                               credentials = scheme, secrets = collected.secrets.len(), bytes = text.len(), kept, "backup created");
                json!({ "ok": true, "name": name, "bytes": text.len(), "file": text, "credentials": scheme,
                        "secrets": if scheme == "none" { 0 } else { collected.secrets.len() },
                        "leftOut": if scheme == "none" { collected.secrets.len() } else { 0 },
                        "kept": kept, "notes": collected.notes,
                        "sections": sections.iter().map(|s| s.id()).collect::<Vec<_>>() })
            }
            "BACKUP_DOWNLOAD" => {
                let Some(name) = msg.get("name").and_then(Value::as_str) else { return bad("bad_request", "name: a kept backup") };
                match self.backup.read_kept(name) {
                    Ok(text) => {
                        tracing::info!(target: "audit", user = %by, name, bytes = text.len(), "backup downloaded");
                        json!({ "ok": true, "name": name, "bytes": text.len(), "file": text })
                    }
                    Err(r) => r.to_json(),
                }
            }
            "BACKUP_DELETE" => {
                let Some(name) = msg.get("name").and_then(Value::as_str) else { return bad("bad_request", "name: a kept backup") };
                let name = match safe_name(name) {
                    Ok(n) => n,
                    Err(r) => return r.to_json(),
                };
                let Some(d) = self.backup.dir() else { return bad("unsupported", "this server keeps no backups") };
                match std::fs::remove_file(d.join(name)) {
                    Ok(()) => {
                        tracing::info!(target: "audit", user = %by, name, "backup deleted");
                        self.backup_status()
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => bad("not_found", format!("{name} is not a kept backup any more")),
                    Err(e) => bad("io", format!("cannot delete {name}: {e}")),
                }
            }
            "BACKUP_SCHEDULE_SET" => {
                if !self.backup.keeps() {
                    return bad("unsupported", "scheduled backups need a hosted server with a data directory");
                }
                let body = msg.get("schedule").cloned().unwrap_or(Value::Null);
                let cur = self.backup.schedule.read().clone();
                let next = match cur.with_message(&body) {
                    Ok(s) => s,
                    Err(e) => return bad("bad_request", e),
                };
                if let Err(e) = self.backup.save_schedule(&next) {
                    return bad("io", format!("the schedule could not be saved: {e}"));
                }
                self.backup.prune(next.keep, &by);
                tracing::info!(target: "audit", user = %by, enabled = next.enabled, every = ?next.every, at = %next.at, keep = next.keep,
                               sections = %next.sections.iter().map(|s| s.id()).collect::<Vec<_>>().join(","), "backup schedule changed");
                self.backup_status()
            }
            "BACKUP_PREVIEW" => {
                let (text, name) = match self.backup_source(msg) {
                    Ok(x) => x,
                    Err(r) => return r.to_json(),
                };
                let parsed = match parse(&text) {
                    Ok(p) => p,
                    Err(r) => return r.to_json(),
                };
                let sections = match Section::from_message(msg.get("sections")) {
                    Ok(s) => s,
                    Err(e) => return bad("bad_request", e),
                };
                // The credentials are opened to prove the password, and dropped: a preview says
                // whether they would come back, never what they are.
                let credentials = match self.backup_secrets(&parsed, msg) {
                    Ok((Some(s), _)) => json!({ "state": "opened", "count": s.len() }),
                    Ok((None, how)) => json!({ "state": how }),
                    Err(r) if r.kind == "password_needed" || r.kind == "server_key" => json!({ "state": "locked", "kind": r.kind, "message": r.message }),
                    Err(r) => return r.to_json(),
                };
                let current = self.backup_collect(&sections).await;
                let p = preview(&current, &parsed.sections, &sections);
                json!({ "ok": true, "name": name, "backup": parsed.header(), "credentials": credentials, "preview": p,
                        "formatVersion": FORMAT_VERSION })
            }
            "BACKUP_RESTORE" => {
                let (text, name) = match self.backup_source(msg) {
                    Ok(x) => x,
                    Err(r) => return r.to_json(),
                };
                let parsed = match parse(&text) {
                    Ok(p) => p,
                    Err(r) => return r.to_json(),
                };
                let mode = match msg.get("mode").and_then(Value::as_str).and_then(Mode::parse) {
                    Some(m) => m,
                    None => return bad("bad_request", "mode: merge (add and update) or replace (everything)"),
                };
                let sections = match Section::from_message(msg.get("sections")) {
                    Ok(s) => s.into_iter().filter(|s| parsed.sections.contains_key(s)).collect::<Vec<_>>(),
                    Err(e) => return bad("bad_request", e),
                };
                if sections.is_empty() {
                    return bad("bad_request", "the backup holds none of the sections asked for");
                }
                let (secrets, credentials) = match self.backup_secrets(&parsed, msg) {
                    Ok(x) => x,
                    Err(r) => return r.to_json(),
                };
                let _one = self.backup.busy.lock().await;
                // The current state first, every section, so this restore can be undone.
                let before = if self.backup.keeps() {
                    let keep = self.backup.schedule.read().keep;
                    match self.backup_keep(&Section::ALL, Kind::BeforeRestore, &by, keep.max(DEFAULT_KEEP), crate::volume::schedule::local_now()).await {
                        Ok((n, _, _)) => Some(n),
                        Err(r) => {
                            let mut out = r.to_json();
                            out["message"] = json!(format!("the current state could not be kept before restoring, so nothing was restored: {}", r.message));
                            return out;
                        }
                    }
                } else {
                    None
                };
                let applied = match self.backup_apply(&parsed, secrets.as_ref(), mode, &sections, &by).await {
                    Ok(a) => a,
                    Err(r) => {
                        tracing::warn!(target: "audit", user = %by, kind = r.kind, reason = %r.message, before = before.as_deref(), "backup restore refused");
                        let mut out = r.to_json();
                        out["beforeRestore"] = json!(before);
                        return out;
                    }
                };
                tracing::info!(target: "audit", user = %by, mode = mode.id(), from = %name.as_deref().unwrap_or("upload"),
                               taken_at = parsed.taken_at, taken_by = %parsed.taken_by, credentials,
                               sections = %sections.iter().map(|s| s.id()).collect::<Vec<_>>().join(","), before = before.as_deref(), "backup restored");
                json!({ "ok": true, "mode": mode.id(), "name": name, "beforeRestore": before, "credentials": credentials,
                        "backup": parsed.header(), "applied": applied })
            }
            _ => bad("bad_request", format!("{t} is not a backup message")),
        }
    }

    /* --------------------------------------- the timer --------------------------------------- */

    /// What the timer does at `local`: a backup when the schedule says so, and the record of it.
    pub async fn backup_tick_at(self: &Arc<Self>, local: chrono::NaiveDateTime) -> Option<Result<String, String>> {
        if !self.backup.keeps() {
            return None;
        }
        let s = self.backup.schedule.read().clone();
        if !s.due(local) {
            return None;
        }
        let _one = self.backup.busy.lock().await;
        let result = self.backup_keep(&s.sections, Kind::Scheduled, "system", s.keep, local).await;
        let day = crate::volume::schedule::day_key(local.date());
        let mut next = self.backup.schedule.read().clone();
        next.last = Some(match &result {
            Ok((name, bytes, _)) => LastRun { at: crate::fleet::now_ms(), ok: true, name: Some(name.clone()), bytes: *bytes, message: None, local_day: day },
            Err(r) => LastRun { at: crate::fleet::now_ms(), ok: false, name: None, bytes: 0, message: Some(r.message.clone()), local_day: day },
        });
        if let Err(e) = self.backup.save_schedule(&next) {
            tracing::warn!("backup schedule: the run record could not be written: {e}");
        }
        Some(match result {
            Ok((name, bytes, secrets)) => {
                tracing::info!(target: "audit", kind = "scheduled", name = %name, bytes, secrets, "backup created");
                Ok(name)
            }
            Err(r) => {
                tracing::warn!(target: "audit", kind = "scheduled", reason = %r.message, "backup failed");
                Err(r.message)
            }
        })
    }

    /// The daily backup, hosted only: once a minute, is the schedule due in server local time.
    pub fn start_backup_timer(self: &Arc<Self>) {
        if !self.backup.keeps() {
            return;
        }
        let core = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tracing::info!(target: "audit", "backup: timer started");
            loop {
                tick.tick().await;
                core.backup_tick_at(crate::volume::schedule::local_now()).await;
            }
        });
    }
}
