//! The mail server: its settings, and one SMTP session at a time.
//!
//! `<data>/mail.json` holds what an admin typed on Config › Volume fields › Mail server;
//! config.txt (`UI_SMTP_*`) wins over it field by field and locks the field. The password
//! is kept sealed under the cluster-secrets key (`ClusterSecrets::seal_own`), never in the
//! clear on disk and never in a reply or a log line: `MAIL_SETTINGS_GET` says
//! `passwordSet`, nothing more. With `UI_SMTP_PASSWORD_FILE` the password is read from that
//! file when a mail is sent, and not kept anywhere by the core.
//!
//! "none" security is allowed only with no authentication: a password over plain text is
//! a password given away, so the combination is refused when saved and again when sent.
//!
//! A session is driven step by step — connect, TLS, auth, send — so `MAIL_TEST` can say
//! which one failed. No pool: a report goes out a few times a month.

use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{AsyncSmtpConnection, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const FILE: &str = "mail.json";
/// The associated data the stored password is sealed with: moved into another file or
/// field, it no longer opens.
pub const SEAL_AAD: &str = "mail.json:password";
/// The longest wait for any one step; a whole session is bounded by `SESSION_TIMEOUT`.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(20);
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    #[default]
    Starttls,
    Tls,
    None,
}

impl Security {
    pub fn parse(s: &str) -> Option<Security> {
        match s.to_ascii_lowercase().as_str() {
            "starttls" => Some(Security::Starttls),
            "tls" => Some(Security::Tls),
            "none" => Some(Security::None),
            _ => None,
        }
    }
    pub fn default_port(self) -> u16 {
        match self {
            Security::Starttls => 587,
            Security::Tls => 465,
            Security::None => 25,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    #[default]
    Password,
    None,
}

/// `mail.json` as kept. `password` is sealed (`crypto::seal_with_key`), or absent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFile {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub security: Security,
    #[serde(default)]
    pub auth: Auth,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default)]
    pub set_by: Option<String>,
    #[serde(default)]
    pub set_at: Option<i64>,
}

/// Where the password comes from, once config.txt has had its say.
#[derive(Clone, PartialEq)]
pub enum PasswordFrom {
    None,
    /// Sealed in `mail.json`.
    Stored(String),
    /// `UI_SMTP_PASSWORD_FILE`: a path, read at send time.
    File(String),
}

impl std::fmt::Debug for PasswordFrom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PasswordFrom::None => f.write_str("None"),
            PasswordFrom::Stored(_) => f.write_str("Stored(<sealed>)"),
            PasswordFrom::File(p) => write!(f, "File({p})"),
        }
    }
}

/// The settings in force: `mail.json` under config.txt.
#[derive(Clone, Debug, PartialEq)]
pub struct Effective {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub auth: Auth,
    pub user: String,
    pub from: String,
    pub password: PasswordFrom,
    /// The fields config.txt sets: `host`, `port`, `security`, `user`, `password`, `from`
    /// (and `auth`, which a password file implies).
    pub managed: Vec<&'static str>,
}

/// config.txt key → field. One table for `effective` and for the parity of `managed`.
pub const MANAGED_KEYS: &[(&str, &str)] = &[
    ("UI_SMTP_HOST", "host"),
    ("UI_SMTP_PORT", "port"),
    ("UI_SMTP_SECURITY", "security"),
    ("UI_SMTP_USER", "user"),
    ("UI_SMTP_PASSWORD_FILE", "password"),
    ("UI_SMTP_FROM", "from"),
];

pub fn effective(file: &MailFile, s: &crate::settings::Settings) -> Effective {
    let mut e = Effective {
        host: file.host.clone(),
        port: 0,
        security: file.security,
        auth: file.auth,
        user: file.user.clone(),
        from: file.from.clone(),
        password: file.password.clone().map(PasswordFrom::Stored).unwrap_or(PasswordFrom::None),
        managed: vec![],
    };
    for (key, field) in MANAGED_KEYS {
        let Some(v) = s.text(key) else { continue };
        match *field {
            "host" => e.host = v.to_string(),
            "port" => e.port = v.parse().unwrap_or(0),
            "security" => e.security = Security::parse(v).unwrap_or(e.security),
            "user" => e.user = v.to_string(),
            "password" => {
                e.password = PasswordFrom::File(v.to_string());
                e.auth = Auth::Password;
                e.managed.push("auth");
            }
            _ => e.from = v.to_string(),
        }
        e.managed.push(field);
    }
    if e.port == 0 {
        e.port = file.port.unwrap_or_else(|| e.security.default_port());
    }
    e
}

impl Effective {
    /// Configured enough to try a send.
    pub fn configured(&self) -> bool {
        !self.host.is_empty() && !self.from.is_empty()
    }

    pub fn password_set(&self) -> bool {
        match &self.password {
            PasswordFrom::None => false,
            PasswordFrom::Stored(_) => true,
            PasswordFrom::File(p) => std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > 0),
        }
    }

    /// The reply of `MAIL_SETTINGS_GET`. No password, not even its length.
    pub fn view(&self) -> Value {
        json!({
            "host": self.host, "port": self.port, "security": self.security, "auth": self.auth,
            "user": self.user, "from": self.from,
            "passwordSet": self.password_set(),
            "passwordFrom": match self.password { PasswordFrom::None => Value::Null, PasswordFrom::Stored(_) => json!("stored"), PasswordFrom::File(_) => json!("config.txt") },
            "managed": self.managed,
            "configured": self.configured(),
            "problem": self.problem(),
        })
    }

    /// What is wrong with these settings for sending, or `None`.
    pub fn problem(&self) -> Option<String> {
        if !self.configured() {
            return Some("no mail server: set the host and the From address".into());
        }
        validate(&self.host, self.port, self.security, self.auth, &self.user, &self.from).err()
            .or_else(|| (self.auth == Auth::Password && !self.password_set()).then(|| "authentication is on but no password is set".into()))
    }
}

/// The rules a saved setting must meet.
pub fn validate(host: &str, port: u16, security: Security, auth: Auth, user: &str, from: &str) -> Result<(), String> {
    let h = host.trim();
    if h.is_empty() || h.len() > 253 || h.chars().any(|c| c.is_whitespace() || c.is_control() || "/@?#".contains(c)) {
        return Err("host must be a host name or an address, without a scheme or a path".into());
    }
    if port == 0 {
        return Err("port must be 1-65535".into());
    }
    if security == Security::None && auth == Auth::Password {
        return Err("security \"none\" is allowed only with auth \"none\": a password must not cross the network in plain text".into());
    }
    if auth == Auth::Password && user.trim().is_empty() {
        return Err("auth \"password\" needs a user".into());
    }
    if user.chars().any(char::is_control) || user.len() > 256 {
        return Err("user has control characters or is too long".into());
    }
    if from.trim().is_empty() {
        return Err("from is required".into());
    }
    from.parse::<Mailbox>().map_err(|e| format!("from {from:?} is not an address: {e}"))?;
    Ok(())
}

/// A list of addresses (`to`, `cc`, `bcc`): each must parse, none twice; at most 100.
pub fn check_addresses(list: &[String], what: &str) -> Result<(), String> {
    if list.len() > 100 {
        return Err(format!("{what}: at most 100 addresses"));
    }
    for (i, a) in list.iter().enumerate() {
        a.parse::<Mailbox>().map_err(|e| format!("{what}: {a:?} is not an address: {e}"))?;
        if list[..i].iter().any(|b| b.eq_ignore_ascii_case(a)) {
            return Err(format!("{what}: {a:?} is listed twice"));
        }
    }
    Ok(())
}

/// Everything a session needs, the password already opened. Its Debug never shows it.
#[derive(Clone)]
pub struct Ready {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub credentials: Option<(String, String)>,
    pub from: String,
}

impl std::fmt::Debug for Ready {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ready").field("host", &self.host).field("port", &self.port).field("security", &self.security)
            .field("user", &self.credentials.as_ref().map(|c| &c.0)).field("password", &"<redacted>").finish()
    }
}

/// A mail as it is handed to the server.
pub struct Outgoing {
    pub envelope: Envelope,
    pub bytes: Vec<u8>,
    pub recipients: usize,
}

/// Build a mail: plain text body and, optionally, one attachment.
pub fn message(from: &str, to: &[String], cc: &[String], bcc: &[String], subject: &str, body: &str,
               attachment: Option<(&str, &str, Vec<u8>)>) -> Result<Outgoing, String> {
    let mb = |a: &str| a.parse::<Mailbox>().map_err(|e| format!("{a:?} is not an address: {e}"));
    let mut b = lettre::Message::builder().from(mb(from)?).subject(subject);
    for a in to {
        b = b.to(mb(a)?);
    }
    for a in cc {
        b = b.cc(mb(a)?);
    }
    for a in bcc {
        b = b.bcc(mb(a)?);
    }
    let text = SinglePart::plain(body.to_string());
    let msg = match attachment {
        None => b.singlepart(text),
        Some((name, mime, data)) => {
            let ct = ContentType::parse(mime).map_err(|e| e.to_string())?;
            b.multipart(MultiPart::mixed().singlepart(text).singlepart(Attachment::new(name.to_string()).body(data, ct)))
        }
    }.map_err(|e| format!("the mail could not be built: {e}"))?;
    Ok(Outgoing { envelope: msg.envelope().clone(), bytes: msg.formatted(), recipients: to.len() + cc.len() + bcc.len() })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Step {
    pub step: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn step(steps: &mut Vec<Step>, name: &'static str, r: Result<String, String>) -> bool {
    let ok = r.is_ok();
    steps.push(Step { step: name, ok, detail: r.unwrap_or_else(|e| e) });
    ok
}

/// One session: connect, TLS (implicit or STARTTLS, or none), auth, and the send when there
/// is a mail. Stops at the first step that fails; the steps taken are the answer.
pub async fn session(r: &Ready, mail: Option<&Outgoing>) -> Vec<Step> {
    let mut steps = vec![];
    let run = session_steps(r, mail, &mut steps);
    if tokio::time::timeout(SESSION_TIMEOUT, run).await.is_err() {
        steps.push(Step { step: "send", ok: false, detail: format!("the session took longer than {} s", SESSION_TIMEOUT.as_secs()) });
    }
    steps
}

async fn session_steps(r: &Ready, mail: Option<&Outgoing>, steps: &mut Vec<Step>) {
    let hello = ClientId::default();
    let addr = (r.host.as_str(), r.port);
    let tls = || TlsParameters::builder(r.host.clone()).build_rustls().map_err(|e| format!("TLS setup: {e}"));
    let mut conn = match r.security {
        Security::Tls => {
            // Implicit TLS connects and handshakes in one call; a bare TCP connect first tells
            // "cannot reach the server" from "the handshake failed".
            let tcp = tokio::time::timeout(STEP_TIMEOUT, tokio::net::TcpStream::connect(addr)).await;
            let reached = match tcp {
                Ok(Ok(_)) => Ok(format!("{}:{} reached", r.host, r.port)),
                Ok(Err(e)) => Err(format!("{}:{}: {e}", r.host, r.port)),
                Err(_) => Err(format!("{}:{}: no answer in {} s", r.host, r.port, STEP_TIMEOUT.as_secs())),
            };
            if !step(steps, "connect", reached) {
                return;
            }
            let params = match tls() {
                Ok(p) => p,
                Err(e) => {
                    step(steps, "tls", Err(e));
                    return;
                }
            };
            match AsyncSmtpConnection::connect_tokio1(addr, Some(STEP_TIMEOUT), &hello, Some(params), None).await {
                Ok(c) => {
                    step(steps, "tls", Ok("implicit TLS, certificate verified".into()));
                    c
                }
                Err(e) => {
                    step(steps, "tls", Err(format!("implicit TLS: {e}")));
                    return;
                }
            }
        }
        _ => match AsyncSmtpConnection::connect_tokio1(addr, Some(STEP_TIMEOUT), &hello, None, None).await {
            Ok(c) => {
                step(steps, "connect", Ok(format!("{}:{} answered", r.host, r.port)));
                c
            }
            Err(e) => {
                step(steps, "connect", Err(format!("{}:{}: {e}", r.host, r.port)));
                return;
            }
        },
    };
    match r.security {
        Security::Starttls => {
            let res = match tls() {
                Err(e) => Err(e),
                Ok(_) if !conn.can_starttls() => Err("the server does not offer STARTTLS".into()),
                Ok(p) => conn.starttls(p, &hello).await.map(|_| "STARTTLS, certificate verified".to_string()).map_err(|e| format!("STARTTLS: {e}")),
            };
            if !step(steps, "tls", res) {
                conn.abort().await;
                return;
            }
        }
        Security::None => {
            step(steps, "tls", Ok("not encrypted (security: none)".into()));
        }
        Security::Tls => {}
    }
    match &r.credentials {
        Some((user, password)) => {
            let res = conn.auth(&[Mechanism::Plain, Mechanism::Login], &Credentials::new(user.clone(), password.clone())).await
                .map(|_| format!("signed in as {user}")).map_err(|e| format!("authentication: {e}"));
            if !step(steps, "auth", res) {
                conn.abort().await;
                return;
            }
        }
        None => {
            step(steps, "auth", Ok("no authentication (auth: none)".into()));
        }
    }
    if let Some(m) = mail {
        let res = conn.send(&m.envelope, &m.bytes).await
            .map(|resp| format!("accepted for {} recipient(s): {}", m.recipients, resp.message().collect::<Vec<_>>().join(" ")))
            .map_err(|e| format!("send: {e}"));
        if !step(steps, "send", res) {
            conn.abort().await;
            return;
        }
    }
    let _ = conn.quit().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_txt_wins_field_by_field_and_a_password_file_implies_auth() {
        let file = MailFile { host: "mail.local".into(), security: Security::None, auth: Auth::None, from: "ep@x.org".into(), ..MailFile::default() };
        let e = effective(&file, &crate::settings::Settings::default());
        assert_eq!((e.port, e.managed.len()), (25, 0), "the port follows the security when unset");
        let s = crate::settings::Settings::parse("UI_SMTP_HOST=smtp.corp\nUI_SMTP_SECURITY=TLS\nUI_SMTP_PASSWORD_FILE=/run/secrets/smtp\nUI_SMTP_USER=svc\n");
        assert!(s.warnings().is_empty(), "{:?}", s.warnings());
        let e = effective(&file, &s);
        assert_eq!((e.host.as_str(), e.security, e.port, e.auth), ("smtp.corp", Security::Tls, 465, Auth::Password));
        assert_eq!(e.password, PasswordFrom::File("/run/secrets/smtp".into()));
        assert_eq!(e.managed, vec!["host", "security", "user", "auth", "password"]);
        assert!(!e.password_set(), "the file does not exist here");
        assert_eq!(e.problem().as_deref(), Some("authentication is on but no password is set"));
    }

    #[test]
    fn validation() {
        assert!(validate("smtp.example.com", 587, Security::Starttls, Auth::Password, "u", "ElasticPro <ep@example.com>").is_ok());
        assert!(validate("smtp.example.com", 25, Security::None, Auth::None, "", "ep@example.com").is_ok());
        let none_pw = validate("smtp.example.com", 25, Security::None, Auth::Password, "u", "ep@example.com").unwrap_err();
        assert!(none_pw.contains("plain text"), "{none_pw}");
        for host in ["", "smtp://x", "a b", "x/y", "user@host"] {
            assert!(validate(host, 25, Security::Tls, Auth::None, "", "ep@example.com").is_err(), "{host}");
        }
        assert!(validate("h", 0, Security::Tls, Auth::None, "", "ep@example.com").is_err());
        assert!(validate("h", 25, Security::Tls, Auth::Password, " ", "ep@example.com").is_err(), "a password needs a user");
        assert!(validate("h", 25, Security::Tls, Auth::None, "", "not an address").is_err());
        assert!(check_addresses(&["a@x.org".into(), "B@x.org".into()], "to").is_ok());
        assert!(check_addresses(&["a@x.org".into(), "A@x.org".into()], "to").is_err(), "twice");
        assert!(check_addresses(&["nope".into()], "cc").is_err());
    }

    #[test]
    fn the_password_is_never_in_the_view_or_a_debug_line() {
        let file = MailFile { host: "h".into(), user: "u".into(), from: "ep@x.org".into(), password: Some("enc:v1:key:SEALED".into()), ..MailFile::default() };
        let e = effective(&file, &crate::settings::Settings::default());
        let v = e.view().to_string();
        assert!(!v.contains("SEALED") && !v.contains("enc:v1"), "{v}");
        assert!(v.contains(r#""passwordSet":true"#) && v.contains(r#""passwordFrom":"stored""#), "{v}");
        assert!(!format!("{e:?}").contains("SEALED"));
        let r = Ready { host: "h".into(), port: 1, security: Security::Tls, credentials: Some(("u".into(), "hunter2".into())), from: "f".into() };
        assert!(!format!("{r:?}").contains("hunter2"));
    }

    #[test]
    fn a_mail_carries_its_attachment_and_hides_bcc() {
        let m = message("ep@x.org", &["a@x.org".into()], &["c@x.org".into()], &["hidden@x.org".into()], "Report · 2026-10",
                        "body", Some(("r.xlsx", super::super::xlsx::MIME, vec![1, 2, 3]))).unwrap();
        assert_eq!(m.recipients, 3);
        assert_eq!(m.envelope.to().len(), 3, "bcc is in the envelope");
        let text = String::from_utf8_lossy(&m.bytes);
        assert!(!text.contains("hidden@x.org"), "and not in the headers");
        assert!(text.contains("r.xlsx") && text.contains("spreadsheetml"), "{text}");
    }
}
