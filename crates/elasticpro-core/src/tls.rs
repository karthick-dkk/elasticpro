//! Certificate trust the operator controls.
//!
//! Three modes per cluster:
//! * `system`   — the OS trust store (plus the Mozilla bundle). Strict.
//! * `auto`     — the default: `system`, and when that fails, trust-on-first-use with an
//!   explicit "Trust this certificate" decision in the UI. The decision is the
//!   certificate's SHA-256, pinned in pins.json; a later change is refused and
//!   reported rather than quietly accepted — a silent re-trust is indistinguishable
//!   from an interception.
//! * `insecure` — accept anything. For a lab, never for production.
//!
//! The same store keeps SSH host-key fingerprints of the jump hosts.

use parking_lot::{Mutex, RwLock};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub const MARK_UNTRUSTED: &str = "ELASTICPRO_UNTRUSTED";
pub const MARK_PIN_MISMATCH: &str = "ELASTICPRO_PIN_MISMATCH";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TlsMode {
    #[default]
    Auto,
    System,
    Insecure,
}

impl TlsMode {
    pub fn parse(s: Option<&str>) -> TlsMode {
        match s.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("system") | Some("strict") => TlsMode::System,
            Some("insecure") | Some("none") | Some("false") => TlsMode::Insecure,
            _ => TlsMode::Auto,
        }
    }
}

/// What the UI needs to show before the operator decides to trust a certificate.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CertInfo {
    pub host: String,
    pub sha256: String,
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    pub self_signed: bool,
    pub sans: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pin {
    pub sha256: String,
    pub subject: String,
    pub since: String,
}

#[derive(Default, Serialize, Deserialize)]
struct PinFile {
    #[serde(default)]
    certs: HashMap<String, Pin>,
    #[serde(default)]
    hostkeys: HashMap<String, Pin>,
}

/// Persistent trust decisions. One file, written atomically.
pub struct PinStore {
    path: Option<PathBuf>,
    data: RwLock<PinFile>,
    /// Certificate most recently presented per `host:port`, trusted or not — the UI asks
    /// for it after an `ELASTICPRO_UNTRUSTED` failure.
    last_seen: Mutex<HashMap<String, CertInfo>>,
}

impl PinStore {
    pub fn open(path: Option<PathBuf>) -> Arc<PinStore> {
        let data = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<PinFile>(&t).ok())
            .unwrap_or_default();
        Arc::new(PinStore { path, data: RwLock::new(data), last_seen: Mutex::new(HashMap::new()) })
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if let Ok(text) = serde_json::to_string_pretty(&*self.data.read()) {
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    pub fn cert_pin(&self, host: &str) -> Option<Pin> {
        self.data.read().certs.get(host).cloned()
    }
    pub fn trust_cert(&self, host: &str, sha256: &str, subject: &str) {
        self.data.write().certs.insert(
            host.to_string(),
            Pin { sha256: sha256.to_string(), subject: subject.to_string(), since: now_iso() },
        );
        self.save();
    }
    pub fn untrust_cert(&self, host: &str) {
        self.data.write().certs.remove(host);
        self.save();
    }
    pub fn hostkey_pin(&self, jump: &str) -> Option<Pin> {
        self.data.read().hostkeys.get(jump).cloned()
    }
    pub fn trust_hostkey(&self, jump: &str, fingerprint: &str, key_type: &str) {
        self.data.write().hostkeys.insert(
            jump.to_string(),
            Pin { sha256: fingerprint.to_string(), subject: key_type.to_string(), since: now_iso() },
        );
        self.save();
    }
    pub fn untrust_hostkey(&self, jump: &str) {
        self.data.write().hostkeys.remove(jump);
        self.save();
    }
    pub fn list(&self) -> serde_json::Value {
        let d = self.data.read();
        serde_json::json!({ "certs": d.certs, "hostkeys": d.hostkeys, "path": self.path })
    }
    pub fn last_seen(&self, host: &str) -> Option<CertInfo> {
        self.last_seen.lock().get(host).cloned()
    }
    fn record(&self, host: &str, info: CertInfo) {
        self.last_seen.lock().insert(host.to_string(), info);
    }
}

pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // civil-from-days (Howard Hinnant), enough for a timestamp without pulling chrono
    let days = (secs / 86400) as i64;
    let (h, m, s) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub fn sha256_hex(der: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(der);
    hex::encode_upper(h.finalize())
}

fn describe(host: &str, der: &[u8]) -> CertInfo {
    let sha256 = sha256_hex(der);
    match x509_parser::parse_x509_certificate(der) {
        Ok((_, c)) => {
            let sans = c
                .subject_alternative_name()
                .ok()
                .flatten()
                .map(|s| s.value.general_names.iter().map(|g| g.to_string()).collect())
                .unwrap_or_default();
            CertInfo {
                host: host.to_string(),
                sha256,
                subject: c.subject().to_string(),
                issuer: c.issuer().to_string(),
                not_before: c.validity().not_before.to_rfc2822().unwrap_or_default(),
                not_after: c.validity().not_after.to_rfc2822().unwrap_or_default(),
                self_signed: c.subject() == c.issuer(),
                sans,
            }
        }
        Err(_) => CertInfo {
            host: host.to_string(),
            sha256,
            subject: "(unparseable certificate)".into(),
            issuer: String::new(),
            not_before: String::new(),
            not_after: String::new(),
            self_signed: false,
            sans: vec![],
        },
    }
}

/// The verifier reqwest/rustls calls for every handshake of one cluster's client.
pub struct PinningVerifier {
    inner: Arc<WebPkiServerVerifier>,
    pins: Arc<PinStore>,
    mode: TlsMode,
    /// `host:port` the client was built for — `ServerName` carries no port.
    key: String,
}

impl std::fmt::Debug for PinningVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PinningVerifier({}, {:?})", self.key, self.mode)
    }
}

static ROOTS: std::sync::OnceLock<Arc<RootCertStore>> = std::sync::OnceLock::new();

fn roots() -> Arc<RootCertStore> {
    ROOTS
        .get_or_init(|| {
            let mut store = RootCertStore::empty();
            // OS store first: this is where an internal CA lands on Windows.
            let native = rustls_native_certs::load_native_certs();
            for c in native.certs {
                let _ = store.add(c);
            }
            store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            Arc::new(store)
        })
        .clone()
}

pub fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    static P: std::sync::OnceLock<Arc<rustls::crypto::CryptoProvider>> = std::sync::OnceLock::new();
    P.get_or_init(|| Arc::new(rustls::crypto::ring::default_provider())).clone()
}

impl PinningVerifier {
    pub fn new(pins: Arc<PinStore>, mode: TlsMode, key: String) -> Arc<PinningVerifier> {
        let inner = WebPkiServerVerifier::builder_with_provider(roots(), provider())
            .build()
            .expect("webpki verifier");
        Arc::new(PinningVerifier { inner, pins, mode, key })
    }

    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn pins(&self) -> &Arc<PinStore> {
        &self.pins
    }

    pub fn client_config(self: &Arc<Self>) -> rustls::ClientConfig {
        rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("tls versions")
            .dangerous()
            .with_custom_certificate_verifier(self.clone())
            .with_no_client_auth()
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let info = describe(&self.key, end_entity.as_ref());
        let fp = info.sha256.clone();
        self.pins.record(&self.key, info);

        if self.mode == TlsMode::Insecure {
            return Ok(ServerCertVerified::assertion());
        }
        let system = self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now);
        if system.is_ok() {
            return system;
        }
        if self.mode == TlsMode::System {
            return system;
        }
        match self.pins.cert_pin(&self.key) {
            Some(pin) if pin.sha256.eq_ignore_ascii_case(&fp) => Ok(ServerCertVerified::assertion()),
            Some(pin) => Err(rustls::Error::General(format!("{MARK_PIN_MISMATCH}:{}:{}", pin.sha256, fp))),
            None => Err(rustls::Error::General(format!("{MARK_UNTRUSTED}:{fp}"))),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iso_time_is_sane() {
        let t = now_iso();
        assert_eq!(t.len(), 20);
        assert!(t.starts_with("20"));
    }
    #[test]
    fn pin_roundtrip() {
        let dir = std::env::temp_dir().join(format!("elasticpro-pins-{}", std::process::id()));
        let store = PinStore::open(Some(dir.join("pins.json")));
        assert!(store.cert_pin("a:9200").is_none());
        store.trust_cert("a:9200", "AB", "CN=a");
        assert_eq!(store.cert_pin("a:9200").unwrap().sha256, "AB");
        let again = PinStore::open(Some(dir.join("pins.json")));
        assert_eq!(again.cert_pin("a:9200").unwrap().sha256, "AB");
        again.untrust_cert("a:9200");
        assert!(again.cert_pin("a:9200").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
