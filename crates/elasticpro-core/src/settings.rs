//! `config.txt`: one settings file for a hosted install (`deploy/config.txt.example` is the
//! contract; every key and its range is documented there).
//!
//! `KEY=VALUE` lines, `#` comments, whitespace trimmed. An empty value is not managed: the
//! default or the Config page decides. A value is managed and **wins** — over the Config
//! page and over a plain environment variable — which is why the UI shows such a setting
//! as "managed by config.txt" and refuses to change it.
//!
//! The core finds the file through `ELASTICPRO_SETTINGS`. Anything wrong with the file
//! itself (missing, a directory where Docker made one for a bind mount that had no host
//! file, unreadable) means no settings and one warning, never a failed start; a single bad
//! line or value is dropped with its own warning and that key stays unmanaged.
//!
//! How a managed value reaches the code that uses it:
//!
//! * Most keys already had an environment variable, and every reader of it stays
//!   unchanged: [`Settings::apply_env`] writes them at the very top of `main`, before the
//!   async runtime exists and before anything reads the environment.
//! * The `zabbix:` options of the config file, `UI_TLS`, `UI_READ_ONLY` and the UI defaults
//!   are not environment variables. The core asks [`get`] where it reads the config file's
//!   value, and PING tells the UI which defaults are managed (see [`Settings::ping_defaults`]).
//!
//! Keys `deploy.sh` consumes itself (ports, allow lists, the container memory limit) are
//! known here and ignored: they are not unknown, and the core has no use for them.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::OnceLock;

/// The environment variable that names the file.
pub const ENV: &str = "ELASTICPRO_SETTINGS";

/// What a value has to look like.
enum Kind {
    Bool,
    /// An integer, inclusive.
    Int(u64, u64),
    Enum(&'static [&'static str]),
    /// Anything without a control character.
    Text,
}

/// How a managed value becomes the environment variable an existing reader consumes.
#[derive(Clone, Copy)]
enum To {
    /// The value, verbatim.
    Env(&'static str),
    /// `true` -> `1`, `false` -> `0`.
    Flag(&'static str),
    /// Not an environment variable: read through [`get`].
    Direct,
}

struct Spec {
    key: &'static str,
    kind: Kind,
    to: To,
}

const fn spec(key: &'static str, kind: Kind, to: To) -> Spec {
    Spec { key, kind, to }
}

const LEVELS: &[&str] = &["error", "warn", "info", "debug", "trace"];

const SPECS: &[Spec] = &[
    // network & access (the rest of that block belongs to deploy.sh)
    spec("TRUSTED_PROXIES", Kind::Text, To::Env("ELASTICPRO_TRUSTED_PROXIES")),
    spec("PROXY_AUTH_HEADER", Kind::Bool, To::Flag("ELASTICPRO_PROXY_AUTH")),
    spec("PUBLIC_URL", Kind::Text, To::Env("ELASTICPRO_PUBLIC_URL")),
    spec("FRAME_ANCESTORS", Kind::Text, To::Env("ELASTICPRO_FRAME_ANCESTORS")),
    // zabbix
    spec("ZABBIX_URL", Kind::Text, To::Env("ELASTICPRO_ZABBIX_URL")),
    spec("ZABBIX_API_URL", Kind::Text, To::Env("ELASTICPRO_ZABBIX_API_URL")),
    spec("ZABBIX_ALLOWED_SOURCES", Kind::Text, To::Env("ELASTICPRO_ZABBIX_ALLOWED_SOURCES")),
    spec("ZABBIX_SYNC_SECONDS", Kind::Int(30, 86_400), To::Env("ELASTICPRO_ZABBIX_SYNC_SECS")),
    // The one inverted name: the environment variable says "insecure". Handled in apply_env.
    spec("ZABBIX_VERIFY_TLS", Kind::Bool, To::Direct),
    spec("ZABBIX_CLUSTER_TEMPLATE", Kind::Text, To::Env("ELASTICPRO_ZABBIX_CLUSTER_TEMPLATE")),
    spec("ZABBIX_SCOPE_USERS_BY_GROUP", Kind::Bool, To::Direct),
    spec("ZABBIX_USE_ELASTICPRO_CREDENTIALS", Kind::Bool, To::Direct),
    spec("ZABBIX_CREATE_HOSTS", Kind::Bool, To::Direct),
    spec("ZABBIX_HOST_GROUP", Kind::Text, To::Direct),
    // The Zabbix host the request figures are pushed to (zbx_push.rs). Empty: no push.
    spec("ZABBIX_METRICS_HOST", Kind::Text, To::Env("ELASTICPRO_ZABBIX_METRICS_HOST")),
    // logging
    spec("ACTIVITY_LOG", Kind::Text, To::Env("ELASTICPRO_ACTIVITY_LOG")),
    spec("ACTIVITY_LOG_MAX_MB", Kind::Int(1, 100_000), To::Env("ELASTICPRO_ACTIVITY_LOG_MAX_MB")),
    spec("ACTIVITY_LOG_KEEP", Kind::Int(0, 1000), To::Env("ELASTICPRO_ACTIVITY_LOG_KEEP")),
    spec("ACTIVITY_LOG_STDOUT", Kind::Bool, To::Flag("ELASTICPRO_ACTIVITY_STDOUT")),
    spec("NOTIFY_DAYS", Kind::Int(1, 3650), To::Env("ELASTICPRO_NOTIFY_DAYS")),
    spec("LOG_LEVEL", Kind::Enum(LEVELS), To::Direct),
    // performance
    spec("POLL_HEALTH_SECONDS", Kind::Int(180, 300), To::Env("ELASTICPRO_POLL_HEALTH_SECS")),
    spec("POLL_CONCURRENCY", Kind::Int(1, 256), To::Env("ELASTICPRO_POLL_CONCURRENCY")),
    spec("ES_CONCURRENCY", Kind::Int(1, 1024), To::Env("ELASTICPRO_ES_CONCURRENCY")),
    spec("ES_PER_CLUSTER", Kind::Int(1, 1024), To::Env("ELASTICPRO_ES_PER_CLUSTER")),
    spec("ES_PER_JUMP_HOST", Kind::Int(1, 1024), To::Env("ELASTICPRO_ES_PER_JUMP_HOST")),
    spec("ES_BACKGROUND_RESERVE", Kind::Int(0, 1023), To::Env("ELASTICPRO_ES_BACKGROUND_RESERVE")),
    spec("ES_QUEUE_MAX", Kind::Int(0, 100_000), To::Env("ELASTICPRO_ES_QUEUE_MAX")),
    spec("ES_QUEUE_PER_USER", Kind::Int(1, 100_000), To::Env("ELASTICPRO_ES_QUEUE_PER_USER")),
    spec("ES_QUEUE_WAIT_MS", Kind::Int(100, 600_000), To::Env("ELASTICPRO_ES_QUEUE_WAIT_MS")),
    spec("ES_MAX_TIMEOUT_MS", Kind::Int(1000, 600_000), To::Env("ELASTICPRO_ES_MAX_TIMEOUT_MS")),
    spec("ES_READ_CACHE_SECONDS", Kind::Int(0, 300), To::Env("ELASTICPRO_ES_READ_CACHE_SECONDS")),
    spec("ES_READ_CACHE_MB", Kind::Int(0, 65_536), To::Env("ELASTICPRO_ES_READ_CACHE_MB")),
    spec("ES_MAX_RESPONSE_MB", Kind::Int(1, 4096), To::Env("ELASTICPRO_ES_MAX_RESPONSE_MB")),
    spec("ES_MAX_FLEET_RESPONSE_MB", Kind::Int(1, 4096), To::Env("ELASTICPRO_ES_MAX_FLEET_RESPONSE_MB")),
    spec("ES_TASK_REAPER", Kind::Enum(&["off", "orphans", "overdue"]), To::Env("ELASTICPRO_ES_TASK_REAPER")),
    spec("ES_TASK_MAX_SECONDS", Kind::Int(30, 86_400), To::Env("ELASTICPRO_ES_TASK_MAX_SECONDS")),
    spec("ZABBIX_CONCURRENCY", Kind::Int(1, 64), To::Env("ELASTICPRO_ZABBIX_CONCURRENCY")),
    spec("CACHE_MB", Kind::Int(1, 1_048_576), To::Env("ELASTICPRO_CACHE_MB")),
    // housekeeping (housekeeping.rs)
    spec("HOUSEKEEPING_MINUTES", Kind::Int(0, 10_080), To::Env("ELASTICPRO_HOUSEKEEPING_MINUTES")),
    spec("HOUSEKEEPING_CACHE_DAYS", Kind::Int(1, 3650), To::Env("ELASTICPRO_HOUSEKEEPING_CACHE_DAYS")),
    spec("HOUSEKEEPING_DRY_RUN", Kind::Bool, To::Flag("ELASTICPRO_HOUSEKEEPING_DRY_RUN")),
    spec("SESSION_IDLE_DAYS", Kind::Int(0, 3650), To::Env("ELASTICPRO_SESSION_IDLE_DAYS")),
    spec("ACTIVITY_LOG_KEEP_DAYS", Kind::Int(0, 3650), To::Env("ELASTICPRO_ACTIVITY_LOG_KEEP_DAYS")),
    // UI defaults: not environment variables; PING carries them to the UI.
    spec("UI_READ_ONLY", Kind::Bool, To::Direct),
    spec("UI_AUTO_REFRESH", Kind::Bool, To::Direct),
    spec("UI_REFRESH_SECONDS", Kind::Int(5, 3600), To::Direct),
    spec("UI_REQUEST_TIMEOUT_MS", Kind::Int(1000, 600_000), To::Direct),
    spec("UI_DISK_WARN_PERCENT", Kind::Int(1, 100), To::Direct),
    spec("UI_DISK_CRIT_PERCENT", Kind::Int(1, 100), To::Direct),
    spec("UI_SNAPSHOT_STALE_HOURS", Kind::Int(1, 24 * 90), To::Direct),
    spec("UI_LOG_INDEX_PATTERN", Kind::Text, To::Direct),
    spec("UI_TIME_FIELD", Kind::Text, To::Direct),
    spec("UI_TLS", Kind::Enum(&["auto", "system", "insecure"]), To::Direct),
    spec("UI_LIVE_REDRAW", Kind::Enum(&["pending", "live", "manual"]), To::Direct),
    spec("UI_DEFAULT_SCOPE", Kind::Enum(&["last-selected", "all"]), To::Direct),
    spec("UI_ROWS_PER_PAGE", Kind::Int(5, 1000), To::Direct),
    spec("UI_MAX_LOG_ROWS", Kind::Int(10, 10_000), To::Direct),
    // The daily volume record (docs/VOLUME.md). Lists are comma-separated field names, tried
    // left to right; the two formats are checked further in `check_text`.
    spec("UI_VOLUME_INDEX_FORMAT", Kind::Text, To::Direct),
    spec("UI_VOLUME_TAG_FIELDS", Kind::Text, To::Direct),
    spec("UI_VOLUME_FORWARDER_FIELDS", Kind::Text, To::Direct),
    spec("UI_VOLUME_HOST_FIELDS", Kind::Text, To::Direct),
    spec("UI_VOLUME_IP_FIELDS", Kind::Text, To::Direct),
    spec("UI_VOLUME_EVENT_SIZE_FIELD", Kind::Text, To::Direct),
    spec("UI_VOLUME_SUB_SIZE_FIELD", Kind::Text, To::Direct),
    spec("UI_VOLUME_EXTRA_NAME", Kind::Text, To::Direct),
    spec("UI_VOLUME_EXTRA_FIELDS", Kind::Text, To::Direct),
    spec("UI_VOLUME_SIZE_BASIS", Kind::Enum(&["primary", "total", "eventSize"]), To::Direct),
    spec("UI_VOLUME_TOP_VALUES", Kind::Int(5, 100), To::Direct),
    spec("UI_VOLUME_KEEP_MONTHS", Kind::Int(1, 36), To::Direct),
    spec("UI_VOLUME_COLLECT_AT", Kind::Text, To::Direct),
    // The volume report by mail (docs/VOLUME.md "Reports and mail"): the mail server, and the
    // mailed report's recipients and schedule. Server settings, not UI defaults: read where
    // they are used (report::mail, report::schedule), shown as locked through `managed` in
    // MAIL_SETTINGS_GET / REPORT_SCHEDULE_GET. The password is never a value here, only the
    // path of a file that holds it, read when a mail is sent.
    spec("UI_SMTP_HOST", Kind::Text, To::Direct),
    spec("UI_SMTP_PORT", Kind::Int(1, 65_535), To::Direct),
    spec("UI_SMTP_SECURITY", Kind::Enum(&["starttls", "tls", "none"]), To::Direct),
    spec("UI_SMTP_USER", Kind::Text, To::Direct),
    spec("UI_SMTP_PASSWORD_FILE", Kind::Text, To::Direct),
    spec("UI_SMTP_FROM", Kind::Text, To::Direct),
    spec("UI_REPORT_TO", Kind::Text, To::Direct),
    spec("UI_REPORT_SCHEDULE", Kind::Enum(&["monthly", "weekly", "daily", "manual"]), To::Direct),
    spec("UI_REPORT_AT", Kind::Text, To::Direct),
    spec("UI_REPORT_SHEETS", Kind::Text, To::Direct),
];

/// `UI_*` key -> the name the UI's `DEFAULTS` (ui/js/core/config.js) gives it.
const UI_DEFAULTS: &[(&str, &str)] = &[
    ("UI_READ_ONLY", "readOnly"),
    ("UI_AUTO_REFRESH", "autoRefresh"),
    ("UI_REFRESH_SECONDS", "refreshIntervalSec"),
    ("UI_REQUEST_TIMEOUT_MS", "requestTimeoutMs"),
    ("UI_DISK_WARN_PERCENT", "diskWarnPercent"),
    ("UI_DISK_CRIT_PERCENT", "diskCritPercent"),
    ("UI_SNAPSHOT_STALE_HOURS", "snapshotStaleHours"),
    ("UI_LOG_INDEX_PATTERN", "logIndexPattern"),
    ("UI_TIME_FIELD", "timeField"),
    ("UI_TLS", "tls"),
    ("UI_LIVE_REDRAW", "liveRedraw"),
    ("UI_DEFAULT_SCOPE", "defaultScope"),
    ("UI_ROWS_PER_PAGE", "tableRowsPerPage"),
    ("UI_MAX_LOG_ROWS", "maxLogRows"),
    ("UI_VOLUME_INDEX_FORMAT", "volumeIndexFormat"),
    ("UI_VOLUME_TAG_FIELDS", "volumeTag"),
    ("UI_VOLUME_FORWARDER_FIELDS", "volumeForwarder"),
    ("UI_VOLUME_HOST_FIELDS", "volumeSourceHost"),
    ("UI_VOLUME_IP_FIELDS", "volumeSourceIp"),
    ("UI_VOLUME_EVENT_SIZE_FIELD", "volumeEventSize"),
    ("UI_VOLUME_SUB_SIZE_FIELD", "volumeSubSize"),
    ("UI_VOLUME_EXTRA_NAME", "volumeExtraName"),
    ("UI_VOLUME_EXTRA_FIELDS", "volumeExtraFields"),
    ("UI_VOLUME_SIZE_BASIS", "volumeSizeBasis"),
    ("UI_VOLUME_TOP_VALUES", "volumeTopValues"),
    ("UI_VOLUME_KEEP_MONTHS", "volumeKeepMonths"),
    ("UI_VOLUME_COLLECT_AT", "volumeCollectAt"),
];

/// The `zabbix:` options of the config file, by the name the UI and the file use.
const ZABBIX_OPTIONS: &[(&str, &str)] = &[
    ("ZABBIX_USE_ELASTICPRO_CREDENTIALS", "useElasticProCredentials"),
    ("ZABBIX_CREATE_HOSTS", "createHosts"),
    ("ZABBIX_SCOPE_USERS_BY_GROUP", "scopeUsersByGroup"),
    ("ZABBIX_HOST_GROUP", "hostGroup"),
];

/// Link fields (zbx_link.rs `FIELDS`) that a key manages, for "managed by config.txt".
pub const ZABBIX_LINK_FIELDS: &[(&str, &str)] = &[
    ("zabbixUrl", "ZABBIX_URL"),
    ("apiUrl", "ZABBIX_API_URL"),
    ("verifyTls", "ZABBIX_VERIFY_TLS"),
    ("allowedSources", "ZABBIX_ALLOWED_SOURCES"),
    ("syncSecs", "ZABBIX_SYNC_SECONDS"),
];

/// Keys `deploy.sh` reads from the same file. Known, so not "unknown"; the core ignores them.
const DEPLOY_KEYS: &[&str] = &["LISTEN_PORT", "ALLOWED_DOMAINS", "ALLOWED_UI_IPS", "RATE_EXEMPT_IPS", "CORE_MEM_LIMIT"];

/// Managed values only, already validated and in canonical form (`true`/`false`, plain
/// decimal, lower-case enum).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Settings {
    values: BTreeMap<&'static str, String>,
    warnings: Vec<String>,
}

impl Settings {
    /// Parse the text of a config.txt. Never fails: what cannot be used is dropped, with a
    /// warning each, and the key stays unmanaged.
    pub fn parse(text: &str) -> Settings {
        let mut s = Settings::default();
        let mut unknown = BTreeSet::new();
        for (n, line) in text.trim_start_matches('\u{feff}').lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                s.warnings.push(format!("line {}: not KEY=VALUE, ignored", n + 1));
                continue;
            };
            let (key, value) = (key.trim(), unquote(value.trim()));
            let Some(sp) = SPECS.iter().find(|sp| sp.key == key) else {
                if !DEPLOY_KEYS.contains(&key) && unknown.insert(key.to_string()) {
                    s.warnings.push(format!("unknown key {key:?} (line {}), ignored", n + 1));
                }
                continue;
            };
            if value.is_empty() {
                // Not managed. A later empty line also un-manages an earlier value: the last
                // line for a key is the one that counts, as in any env file.
                s.values.remove(sp.key);
                continue;
            }
            match canonical(&sp.kind, value).and_then(|v| check_text(sp.key, v)) {
                Ok(v) => {
                    s.values.insert(sp.key, v);
                }
                Err(why) => {
                    s.values.remove(sp.key);
                    s.warnings.push(format!("{key}: {why}; the setting is not managed"));
                }
            }
        }
        s
    }

    /// Read the file at `path`. A missing file, a directory in its place and an unreadable
    /// file all mean no settings and one warning.
    pub fn from_path(path: &Path) -> Settings {
        let problem = |why: String| Settings { values: BTreeMap::new(), warnings: vec![format!("{}: {why}; no settings are managed", path.display())] };
        match std::fs::metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => problem("the file does not exist".into()),
            Err(e) => problem(format!("cannot be read ({e})")),
            Ok(m) if m.is_dir() => problem("is a directory, not a file (Docker makes one when a bind-mounted host file is missing: create deploy/config.txt)".into()),
            Ok(_) => match std::fs::read(path) {
                Err(e) => problem(format!("cannot be read ({e})")),
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => Settings::parse(&text),
                    Err(_) => problem("is not UTF-8 text".into()),
                },
            },
        }
    }

    /// From `ELASTICPRO_SETTINGS`; none when it is unset or empty.
    pub fn from_env() -> Settings {
        match std::env::var(ENV).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            Some(p) => Settings::from_path(Path::new(&p)),
            None => Settings::default(),
        }
    }

    /// What was wrong, for the log. Logged by [`report`] once tracing is up.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Whether this key has a managed value.
    pub fn manages(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn flag(&self, key: &str) -> Option<bool> {
        self.text(key).map(|v| v == "true")
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Set the environment variables the existing readers consume. Call it once, at the top
    /// of `main`, before the async runtime or any other thread exists: `set_var` is only
    /// sound while nothing else can be reading the environment.
    pub fn apply_env(&self) {
        for sp in SPECS {
            let Some(v) = self.values.get(sp.key) else { continue };
            match sp.to {
                To::Env(name) => std::env::set_var(name, v),
                To::Flag(name) => std::env::set_var(name, if v == "true" { "1" } else { "0" }),
                To::Direct => {}
            }
        }
        // The environment names the unsafe state; the setting names the safe one. "0" rather
        // than unsetting it, so that `true` here still beats a stray `=1` in the environment.
        if let Some(verify) = self.flag("ZABBIX_VERIFY_TLS") {
            std::env::set_var("ELASTICPRO_ZABBIX_API_INSECURE", if verify { "0" } else { "1" });
        }
        // `audit` lines are warnings; a level of "error" must not silence the record of who
        // did what.
        if let Some(level) = self.text("LOG_LEVEL") {
            std::env::set_var("RUST_LOG", format!("{level},audit=info"));
        }
    }

    /// The managed UI defaults, under the names `DEFAULTS` in the UI uses. Only managed keys.
    pub fn ping_defaults(&self) -> Value {
        let mut m = Map::new();
        for (key, name) in UI_DEFAULTS {
            if let Some(v) = self.typed(key) {
                m.insert((*name).into(), v);
            }
        }
        Value::Object(m)
    }

    /// The managed `zabbix:` options. Only managed keys.
    pub fn ping_zabbix_options(&self) -> Value {
        let mut m = Map::new();
        for (key, name) in ZABBIX_OPTIONS {
            if let Some(v) = self.typed(key) {
                m.insert((*name).into(), v);
            }
        }
        Value::Object(m)
    }

    /// Which Zabbix link fields this file manages, for "managed by config.txt".
    pub fn zabbix_link_managed(&self) -> Value {
        let mut m = Map::new();
        for (field, key) in ZABBIX_LINK_FIELDS {
            if self.manages(key) {
                m.insert((*field).into(), json!("config.txt"));
            }
        }
        Value::Object(m)
    }

    fn typed(&self, key: &str) -> Option<Value> {
        let sp = SPECS.iter().find(|sp| sp.key == key)?;
        let v = self.values.get(key)?;
        Some(match sp.kind {
            Kind::Bool => json!(v == "true"),
            Kind::Int(..) => json!(v.parse::<u64>().ok()?),
            Kind::Enum(_) | Kind::Text => json!(v),
        })
    }
}

fn unquote(v: &str) -> &str {
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return v[1..v.len() - 1].trim();
        }
    }
    v
}

fn canonical(kind: &Kind, v: &str) -> Result<String, String> {
    if v.chars().any(char::is_control) {
        return Err("contains a control character".into());
    }
    match kind {
        Kind::Text => Ok(v.to_string()),
        Kind::Bool => match v.to_ascii_lowercase().as_str() {
            t @ ("true" | "false") => Ok(t.to_string()),
            _ => Err(format!("{v:?} is not true or false")),
        },
        Kind::Int(lo, hi) => match v.parse::<u64>() {
            Ok(n) if (*lo..=*hi).contains(&n) => Ok(n.to_string()),
            _ => Err(format!("{v:?} is not a whole number from {lo} to {hi}")),
        },
        // Matched without regard to case, kept in the option's own spelling: `eventsize` in
        // the file is `eventSize` to everything that reads it.
        Kind::Enum(options) => match options.iter().find(|o| o.eq_ignore_ascii_case(v)) {
            Some(o) => Ok(o.to_string()),
            None => Err(format!("{v:?} is not one of {}", options.join(", "))),
        },
    }
}

/// What a text key has to look like beyond "no control character". deploy.sh `cfg_check`
/// applies the same two rules.
fn check_text(key: &str, v: String) -> Result<String, String> {
    match key {
        "UI_VOLUME_INDEX_FORMAT" => match crate::volume::settings::index_format_problem(&v) {
            None => Ok(v),
            Some(why) => Err(format!("{v:?} {why}, e.g. logstash-*-YYYY.MM.DD")),
        },
        "UI_VOLUME_COLLECT_AT" | "UI_REPORT_AT" => match crate::volume::schedule::parse_hhmm(&v) {
            Some(_) => Ok(v),
            None => Err(format!("{v:?} is not a time of day HH:MM, 00:00 to 23:59")),
        },
        "UI_SMTP_HOST" => match crate::report::mail::validate(&v, 25, crate::report::mail::Security::Tls, crate::report::mail::Auth::None, "", "x@example.com") {
            Ok(()) => Ok(v),
            Err(_) => Err(format!("{v:?} is not a host name or an address (no scheme, no path)")),
        },
        "UI_SMTP_FROM" => match v.parse::<lettre::message::Mailbox>() {
            Ok(_) => Ok(v),
            Err(_) => Err(format!("{v:?} is not a mail address")),
        },
        "UI_REPORT_TO" => {
            let list = crate::report::schedule::comma_list(&v);
            if list.is_empty() {
                return Err("names no address".into());
            }
            crate::report::mail::check_addresses(&list, "UI_REPORT_TO").map(|_| v)
        }
        "UI_REPORT_SHEETS" => crate::report::schedule::check_sheets(&crate::report::schedule::comma_list(&v)).map(|_| v),
        _ => Ok(v),
    }
}

static GLOBAL: OnceLock<Settings> = OnceLock::new();

/// Load `ELASTICPRO_SETTINGS`, remember it for [`get`] and apply it to the environment. The
/// first call wins. Call before the async runtime starts (see [`Settings::apply_env`]).
pub fn init() -> &'static Settings {
    init_with(Settings::from_env())
}

/// [`init`] with settings already in hand (tests).
pub fn init_with(s: Settings) -> &'static Settings {
    GLOBAL.get_or_init(|| {
        s.apply_env();
        s
    })
}

/// The loaded settings; none managed when [`init`] was never called (the desktop app, tests).
pub fn get() -> &'static Settings {
    static NONE: OnceLock<Settings> = OnceLock::new();
    GLOBAL.get().unwrap_or_else(|| NONE.get_or_init(Settings::default))
}

/// Log what loading found. A separate step because the environment (RUST_LOG) has to be set
/// before the log is, so loading cannot log for itself.
pub fn report() {
    let s = get();
    for w in s.warnings() {
        tracing::warn!("{ENV}: {w}");
    }
    if !s.is_empty() {
        tracing::info!(managed = s.values.len(), "settings managed by config.txt: {}", s.values.keys().copied().collect::<Vec<_>>().join(", "));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_blanks_and_whitespace() {
        let s = Settings::parse("# a comment\n\n   NOTIFY_DAYS =  45  \r\nPUBLIC_URL=https://ep.example.com\n  # indented comment\nCACHE_MB=\n");
        assert_eq!(s.text("NOTIFY_DAYS"), Some("45"));
        assert_eq!(s.text("PUBLIC_URL"), Some("https://ep.example.com"));
        assert!(!s.manages("CACHE_MB"), "an empty value is not managed");
        assert!(s.warnings().is_empty(), "{:?}", s.warnings());
    }

    #[test]
    fn a_value_may_hold_an_equals_sign_and_quotes_are_optional() {
        let s = Settings::parse("PUBLIC_URL=\"https://x/?a=b\"\nZABBIX_HOST_GROUP='ES clusters'\n");
        assert_eq!(s.text("PUBLIC_URL"), Some("https://x/?a=b"));
        assert_eq!(s.text("ZABBIX_HOST_GROUP"), Some("ES clusters"));
    }

    #[test]
    fn unknown_keys_warn_once_each_and_deploy_keys_are_known() {
        let s = Settings::parse("NOPE=1\nNOPE=2\nlisten_port=1\nLISTEN_PORT=443\nCORE_MEM_LIMIT=1g\nno equals here\n");
        let w = s.warnings();
        assert_eq!(w.iter().filter(|m| m.contains("\"NOPE\"")).count(), 1, "{w:?}");
        assert_eq!(w.iter().filter(|m| m.contains("listen_port")).count(), 1, "keys are case sensitive: {w:?}");
        assert!(!w.iter().any(|m| m.contains("LISTEN_PORT") || m.contains("CORE_MEM_LIMIT")), "{w:?}");
        assert!(w.iter().any(|m| m.contains("not KEY=VALUE")), "{w:?}");
        assert!(s.is_empty());
    }

    #[test]
    fn invalid_values_are_not_managed() {
        let s = Settings::parse("\
UI_REFRESH_SECONDS=2\nUI_REQUEST_TIMEOUT_MS=soon\nUI_READ_ONLY=maybe\nUI_TLS=sloppy\nPOLL_HEALTH_SECONDS=60\n\
ES_CONCURRENCY=2000\nLOG_LEVEL=loud\nZABBIX_SYNC_SECONDS=10\nUI_AUTO_REFRESH=TRUE\nUI_TLS=Insecure\n");
        for k in ["UI_REFRESH_SECONDS", "UI_REQUEST_TIMEOUT_MS", "UI_READ_ONLY", "POLL_HEALTH_SECONDS", "ES_CONCURRENCY", "LOG_LEVEL", "ZABBIX_SYNC_SECONDS"] {
            assert!(!s.manages(k), "{k} should have been rejected");
        }
        assert_eq!(s.warnings().len(), 8, "{:?}", s.warnings());
        assert_eq!(s.flag("UI_AUTO_REFRESH"), Some(true), "case does not matter for a boolean");
        assert_eq!(s.text("UI_TLS"), Some("insecure"), "a later valid line replaces an invalid earlier one");
    }

    #[test]
    fn volume_keys_validate_their_formats_and_reach_ping() {
        let s = Settings::parse("UI_VOLUME_INDEX_FORMAT=logs-*-YYYY.MM.DD\nUI_VOLUME_COLLECT_AT=05:30\n\
                                  UI_VOLUME_SIZE_BASIS=EVENTSIZE\nUI_VOLUME_TAG_FIELDS=tag1, tags\nUI_VOLUME_TOP_VALUES=50\n");
        assert!(s.warnings().is_empty(), "{:?}", s.warnings());
        assert_eq!(s.text("UI_VOLUME_SIZE_BASIS"), Some("eventSize"), "kept in the option's spelling");
        assert_eq!(s.ping_defaults(), json!({ "volumeIndexFormat": "logs-*-YYYY.MM.DD", "volumeCollectAt": "05:30",
                                              "volumeSizeBasis": "eventSize", "volumeTag": "tag1, tags", "volumeTopValues": 50 }));
        let bad = Settings::parse("UI_VOLUME_INDEX_FORMAT=logs-YYYY.MM.DD\nUI_VOLUME_COLLECT_AT=6:00\nUI_VOLUME_KEEP_MONTHS=48\n\
                                    UI_VOLUME_INDEX_FORMAT=logs-*\nUI_VOLUME_COLLECT_AT=24:00\n");
        assert!(!bad.manages("UI_VOLUME_INDEX_FORMAT") && !bad.manages("UI_VOLUME_COLLECT_AT") && !bad.manages("UI_VOLUME_KEEP_MONTHS"));
        assert_eq!(bad.warnings().len(), 5, "{:?}", bad.warnings());
    }

    #[test]
    fn mail_and_report_keys_validate_and_stay_out_of_ping() {
        let s = Settings::parse("UI_SMTP_HOST=smtp.example.com\nUI_SMTP_PORT=587\nUI_SMTP_SECURITY=STARTTLS\nUI_SMTP_FROM=ElasticPro <ep@example.com>\n\
                                  UI_SMTP_PASSWORD_FILE=/run/secrets/smtp\nUI_REPORT_TO=a@example.com, b@example.com\n\
                                  UI_REPORT_SCHEDULE=Monthly\nUI_REPORT_AT=07:30\nUI_REPORT_SHEETS=daily,breakdown\n");
        assert!(s.warnings().is_empty(), "{:?}", s.warnings());
        assert_eq!((s.text("UI_SMTP_SECURITY"), s.text("UI_REPORT_SCHEDULE")), (Some("starttls"), Some("monthly")));
        assert_eq!(s.ping_defaults(), json!({}), "server settings, not UI defaults");
        let bad = Settings::parse("UI_SMTP_HOST=smtp://x\nUI_SMTP_PORT=0\nUI_SMTP_SECURITY=ssl\nUI_SMTP_FROM=nobody\n\
                                    UI_REPORT_TO=a@example.com, nope\nUI_REPORT_SCHEDULE=hourly\nUI_REPORT_AT=7:30\nUI_REPORT_SHEETS=weekly\n");
        for k in ["UI_SMTP_HOST", "UI_SMTP_PORT", "UI_SMTP_SECURITY", "UI_SMTP_FROM", "UI_REPORT_TO", "UI_REPORT_SCHEDULE", "UI_REPORT_AT", "UI_REPORT_SHEETS"] {
            assert!(!bad.manages(k), "{k} should have been rejected");
        }
        assert_eq!(bad.warnings().len(), 8, "{:?}", bad.warnings());
    }

    #[test]
    fn the_last_line_for_a_key_counts() {
        let s = Settings::parse("NOTIFY_DAYS=10\nNOTIFY_DAYS=20\nCACHE_MB=64\nCACHE_MB=\nUI_DISK_WARN_PERCENT=70\nUI_DISK_WARN_PERCENT=500\n");
        assert_eq!(s.text("NOTIFY_DAYS"), Some("20"));
        assert!(!s.manages("CACHE_MB"));
        assert!(!s.manages("UI_DISK_WARN_PERCENT"), "an invalid later line leaves the key unmanaged, not on its earlier value");
    }

    #[test]
    fn a_missing_file_a_directory_and_junk_mean_no_settings() {
        let dir = std::env::temp_dir().join(format!("ep-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = Settings::from_path(&dir.join("nope.txt"));
        assert!(missing.is_empty());
        assert_eq!(missing.warnings().len(), 1);
        assert!(missing.warnings()[0].contains("does not exist"), "{:?}", missing.warnings());
        // A directory where the file should be: what Docker creates for a missing bind mount.
        let as_dir = Settings::from_path(&dir);
        assert!(as_dir.is_empty());
        assert_eq!(as_dir.warnings().len(), 1);
        assert!(as_dir.warnings()[0].contains("is a directory"), "{:?}", as_dir.warnings());
        let bin = dir.join("bin.txt");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        let junk = Settings::from_path(&bin);
        assert!(junk.is_empty() && junk.warnings().len() == 1, "{:?}", junk.warnings());
        let ok = dir.join("config.txt");
        std::fs::write(&ok, "\u{feff}NOTIFY_DAYS=7\n").unwrap();
        assert_eq!(Settings::from_path(&ok).text("NOTIFY_DAYS"), Some("7"), "a BOM from a Windows editor is tolerated");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ping_carries_only_managed_keys_under_the_ui_names() {
        let s = Settings::parse("UI_READ_ONLY=false\nUI_REFRESH_SECONDS=60\nUI_TIME_FIELD=ts\nUI_ROWS_PER_PAGE=25\nUI_LIVE_REDRAW=\n\
                                  ZABBIX_CREATE_HOSTS=true\nZABBIX_HOST_GROUP=ES\nZABBIX_URL=https://z\nZABBIX_VERIFY_TLS=false\n");
        assert_eq!(s.ping_defaults(), json!({ "readOnly": false, "refreshIntervalSec": 60, "timeField": "ts", "tableRowsPerPage": 25 }));
        assert_eq!(s.ping_zabbix_options(), json!({ "createHosts": true, "hostGroup": "ES" }));
        assert_eq!(s.zabbix_link_managed(), json!({ "zabbixUrl": "config.txt", "verifyTls": "config.txt" }));
        assert_eq!(Settings::default().ping_defaults(), json!({}));
    }

    #[test]
    fn every_key_in_the_example_is_known() {
        // deploy/config.txt.example is the contract; a key it lists must not be "unknown".
        let example = include_str!("../../../deploy/config.txt.example");
        let mut keys = 0;
        for line in example.lines() {
            let l = line.trim().trim_start_matches('#').trim();
            if let Some((k, _)) = l.split_once('=') {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
                    keys += 1;
                    assert!(SPECS.iter().any(|s| s.key == k) || DEPLOY_KEYS.contains(&k), "{k} is in config.txt.example but not handled");
                }
            }
        }
        assert!(keys > 30, "{keys}");
    }
}
