//! SSH jump-host tunnels — the app's own SSH client, no ssh.exe, no PuTTY.
//!
//! One `Tunnel` per jump host. Clusters marked `via: <jump>` reach Elasticsearch through
//! `direct-tcpip` channels on that connection (what `ssh -D` does), served to the HTTP
//! client by the in-process SOCKS5 listener in `socks.rs`.
//!
//! Host keys are trust-on-first-use with an explicit decision in the UI, then pinned;
//! a changed key is refused. Authentication is a private key file (optionally
//! passphrase-protected — the passphrase is asked for and kept in memory only) or a
//! session password. The connection is re-established on demand with back-off when the
//! jump host drops it.

use crate::tls::PinStore;
use parking_lot::Mutex;
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JumpSpec {
    pub id: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_file: Option<String>,
    /// Never read from the YAML — supplied by the UI for the session.
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}
fn default_port() -> u16 {
    22
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TunnelState {
    Idle,
    Connecting,
    Up,
    Down { error: String, kind: String },
}

#[derive(Debug, Error)]
pub enum SshError {
    #[error("jump host key is not trusted yet ({key_type} {fingerprint}); confirm it in the UI")]
    HostKeyUnknown { fingerprint: String, key_type: String },
    #[error("jump host key CHANGED (pinned {pinned}, now {offered}). Refusing to connect.")]
    HostKeyMismatch { pinned: String, offered: String },
    #[error("private key {path} needs a passphrase")]
    PassphraseNeeded { path: String },
    #[error("the passphrase for {path} was not accepted")]
    PassphraseWrong { path: String },
    #[error("could not read private key {path}: {reason}")]
    KeyUnreadable { path: String, reason: String },
    #[error("authentication failed for {user}@{host} — key not accepted on the jump host")]
    AuthFailed { user: String, host: String },
    #[error("no authentication method configured for {id}: give keyFile or a password")]
    NoAuth { id: String },
    #[error("cannot reach jump host {host}:{port}: {reason}")]
    Connect { host: String, port: u16, reason: String },
    #[error("jump host refused the forward to {target}: {reason}")]
    Forward { target: String, reason: String },
    #[error("ssh: {0}")]
    Other(String),
}

impl SshError {
    pub fn kind(&self) -> &'static str {
        match self {
            SshError::HostKeyUnknown { .. } => "hostkey_unknown",
            SshError::HostKeyMismatch { .. } => "hostkey_mismatch",
            SshError::PassphraseNeeded { .. } => "passphrase_needed",
            SshError::PassphraseWrong { .. } => "passphrase_wrong",
            SshError::KeyUnreadable { .. } => "key_unreadable",
            SshError::AuthFailed { .. } => "auth_failed",
            SshError::NoAuth { .. } => "no_auth",
            SshError::Connect { .. } => "connect",
            SshError::Forward { .. } => "forward",
            SshError::Other(_) => "ssh",
        }
    }
}

struct Handler {
    jump_id: String,
    pins: Arc<PinStore>,
    /// Key the server offered on the last handshake, for the UI's trust prompt.
    offered: Arc<Mutex<Option<(String, String)>>>,
    dropped: Arc<Mutex<bool>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let (fp, kt) = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                (key.fingerprint(HashAlg::Sha256).to_string(), key.algorithm().to_string())
            }
            PublicKeyOrCertificate::Certificate(c) => {
                (c.public_key().fingerprint(HashAlg::Sha256).to_string(), format!("{}-cert", c.algorithm()))
            }
        };
        *self.offered.lock() = Some((fp.clone(), kt.clone()));
        match self.pins.hostkey_pin(&self.jump_id) {
            Some(p) if p.sha256 == fp => Ok(true),
            _ => Ok(false),
        }
    }

    fn disconnected(
        &mut self,
        _reason: client::DisconnectReason<Self::Error>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        *self.dropped.lock() = true;
        async { Ok(()) }
    }
}

pub struct Tunnel {
    pub spec: JumpSpec,
    pins: Arc<PinStore>,
    handle: tokio::sync::Mutex<Option<Arc<Handle<Handler>>>>,
    state: Mutex<TunnelState>,
    offered: Arc<Mutex<Option<(String, String)>>>,
    dropped: Arc<Mutex<bool>>,
    next_attempt: Mutex<Instant>,
    failures: Mutex<u32>,
}

impl Tunnel {
    pub fn new(spec: JumpSpec, pins: Arc<PinStore>) -> Arc<Tunnel> {
        Arc::new(Tunnel {
            spec,
            pins,
            handle: tokio::sync::Mutex::new(None),
            state: Mutex::new(TunnelState::Idle),
            offered: Arc::new(Mutex::new(None)),
            dropped: Arc::new(Mutex::new(false)),
            next_attempt: Mutex::new(Instant::now()),
            failures: Mutex::new(0),
        })
    }

    pub fn state(&self) -> TunnelState {
        self.state.lock().clone()
    }

    pub fn offered_hostkey(&self) -> Option<(String, String)> {
        self.offered.lock().clone()
    }

    pub fn status_json(&self, socks_port: Option<u16>) -> serde_json::Value {
        let pinned = self.pins.hostkey_pin(&self.spec.id);
        serde_json::json!({
            "id": self.spec.id, "host": self.spec.host, "port": self.spec.port, "user": self.spec.user,
            "keyFile": self.spec.key_file, "socksPort": socks_port,
            "status": self.state(),
            "hostKeyPinned": pinned.as_ref().map(|p| p.sha256.clone()),
            "hostKeyOffered": self.offered_hostkey().map(|(fp, kt)| serde_json::json!({"fingerprint": fp, "keyType": kt})),
        })
    }

    fn set_state(&self, s: TunnelState) {
        *self.state.lock() = s;
    }

    /// Establish the session (once), or reuse the live one.
    async fn session(self: &Arc<Self>) -> Result<Arc<Handle<Handler>>, SshError> {
        let mut guard = self.handle.lock().await;
        if let Some(h) = guard.as_ref() {
            if !h.is_closed() && !*self.dropped.lock() {
                return Ok(h.clone());
            }
        }
        *guard = None;
        // back-off after repeated failures, so forty clusters do not hammer a dead jump host
        let wait = {
            let na = *self.next_attempt.lock();
            na.saturating_duration_since(Instant::now())
        };
        if !wait.is_zero() {
            if let TunnelState::Down { error, kind } = self.state() {
                return Err(SshError::Other(format!("{error} (retry in {}s) [{kind}]", wait.as_secs())));
            }
        }
        self.set_state(TunnelState::Connecting);
        match self.connect().await {
            Ok(h) => {
                *self.failures.lock() = 0;
                *self.dropped.lock() = false;
                self.set_state(TunnelState::Up);
                let h = Arc::new(h);
                *guard = Some(h.clone());
                Ok(h)
            }
            Err(e) => {
                let mut f = self.failures.lock();
                *f += 1;
                let delay = Duration::from_secs(2u64.pow((*f).min(5)));
                *self.next_attempt.lock() = Instant::now() + delay;
                self.set_state(TunnelState::Down { error: e.to_string(), kind: e.kind().to_string() });
                Err(e)
            }
        }
    }

    async fn connect(self: &Arc<Self>) -> Result<Handle<Handler>, SshError> {
        let spec = &self.spec;
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let handler = Handler {
            jump_id: spec.id.clone(),
            pins: self.pins.clone(),
            offered: self.offered.clone(),
            dropped: self.dropped.clone(),
        };
        let addr = (spec.host.as_str(), spec.port);
        let connect = tokio::time::timeout(Duration::from_secs(20), client::connect(config, addr, handler));
        let mut session = match connect.await {
            Ok(Ok(s)) => s,
            Ok(Err(russh::Error::UnknownKey)) => {
                let (fp, kt) = self.offered_hostkey().unwrap_or_default();
                return Err(match self.pins.hostkey_pin(&spec.id) {
                    Some(p) => SshError::HostKeyMismatch { pinned: p.sha256, offered: fp },
                    None => SshError::HostKeyUnknown { fingerprint: fp, key_type: kt },
                });
            }
            Ok(Err(e)) => {
                return Err(SshError::Connect { host: spec.host.clone(), port: spec.port, reason: e.to_string() })
            }
            Err(_) => {
                return Err(SshError::Connect { host: spec.host.clone(), port: spec.port, reason: "timeout".into() })
            }
        };

        let authed = if let Some(path) = spec.key_file.as_deref().filter(|p| !p.trim().is_empty()) {
            let key = match load_secret_key(path, spec.passphrase.as_deref()) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    return Err(SshError::PassphraseNeeded { path: path.to_string() })
                }
                Err(e) => {
                    let reason = e.to_string();
                    // a wrong passphrase surfaces as a decryption ("cryptographic") error
                    if spec.passphrase.is_some() && (reason.to_lowercase().contains("crypt") || reason.to_lowercase().contains("decrypt")) {
                        return Err(SshError::PassphraseWrong { path: path.to_string() });
                    }
                    return Err(SshError::KeyUnreadable { path: path.to_string(), reason });
                }
            };
            // RSA keys must be signed with SHA-2 — OpenSSH 8.8+ rejects ssh-rsa (SHA-1).
            // The server advertises what it accepts; if it did not, SHA-512 is the safe bet.
            let hash = match session.best_supported_rsa_hash().await {
                Ok(Some(h)) => h,
                _ => None,
            };
            let hash = if key.algorithm().is_rsa() { hash.or(Some(HashAlg::Sha512)) } else { None };
            session
                .authenticate_publickey(spec.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| SshError::Other(e.to_string()))?
                .success()
        } else if let Some(pw) = spec.password.as_deref() {
            session
                .authenticate_password(spec.user.clone(), pw)
                .await
                .map_err(|e| SshError::Other(e.to_string()))?
                .success()
        } else {
            return Err(SshError::NoAuth { id: spec.id.clone() });
        };
        if !authed {
            return Err(SshError::AuthFailed { user: spec.user.clone(), host: spec.host.clone() });
        }
        Ok(session)
    }

    /// A stream to `host:port` on the far side of the jump host.
    pub async fn open(self: &Arc<Self>, host: &str, port: u16) -> Result<russh::ChannelStream<client::Msg>, SshError> {
        let target = format!("{host}:{port}");
        let mut attempt = 0;
        loop {
            let h = self.session().await?;
            match h.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await {
                Ok(ch) => return Ok(ch.into_stream()),
                Err(e) => {
                    // A dead session shows up here first; reconnect once, then give up.
                    let dead = h.is_closed() || *self.dropped.lock() || matches!(e, russh::Error::SendError);
                    if dead && attempt == 0 {
                        attempt += 1;
                        *self.handle.lock().await = None;
                        *self.dropped.lock() = true;
                        continue;
                    }
                    return Err(SshError::Forward { target, reason: e.to_string() });
                }
            }
        }
    }

    pub async fn close(self: &Arc<Self>) {
        if let Some(h) = self.handle.lock().await.take() {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "bye", "en").await;
        }
        self.set_state(TunnelState::Idle);
    }

    /// Forget the back-off so the next request tries immediately (after a trust decision).
    pub fn reset_backoff(&self) {
        *self.failures.lock() = 0;
        *self.next_attempt.lock() = Instant::now();
        if matches!(self.state(), TunnelState::Down { .. }) {
            self.set_state(TunnelState::Idle);
        }
    }

    /// True while a failed connection is waiting out its back-off delay.
    pub fn backing_off(&self) -> bool {
        *self.next_attempt.lock() > Instant::now()
    }
}
