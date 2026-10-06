//! A TLS server on loopback whose certificate can be swapped underneath a live address —
//! which is what a certificate rotation (or an interception) looks like to the client.

#![allow(dead_code)]

use super::{read_request, Hit};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

/// A self-signed certificate and its SHA-256, as the app would show it before pinning.
pub struct SelfSigned {
    pub cert: CertificateDer<'static>,
    pub key: Vec<u8>,
    pub sha256: String,
}

pub fn self_signed(name: &str) -> SelfSigned {
    let c = rcgen::generate_simple_self_signed(vec![name.to_string()]).expect("rcgen");
    let cert = c.cert.der().clone();
    let sha256 = elasticpro_core::tls::sha256_hex(cert.as_ref());
    SelfSigned { cert, key: c.key_pair.serialize_der(), sha256 }
}

fn server_config(c: &SelfSigned) -> Arc<rustls::ServerConfig> {
    let key = PrivatePkcs8KeyDer::from(c.key.clone());
    let cfg = rustls::ServerConfig::builder_with_provider(elasticpro_core::tls::provider())
        .with_safe_default_protocol_versions()
        .expect("tls versions")
        .with_no_client_auth()
        .with_single_cert(vec![c.cert.clone()], key.into())
        .expect("server cert");
    Arc::new(cfg)
}

pub struct TlsServer {
    pub port: u16,
    config: Arc<Mutex<Arc<rustls::ServerConfig>>>,
    hits: Arc<Mutex<Vec<Hit>>>,
    handshakes: Arc<AtomicUsize>,
}

impl TlsServer {
    pub async fn start(cert: &SelfSigned) -> TlsServer {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let config = Arc::new(Mutex::new(server_config(cert)));
        let hits = Arc::new(Mutex::new(Vec::new()));
        let handshakes = Arc::new(AtomicUsize::new(0));

        let (cfg, h, hs) = (config.clone(), hits.clone(), handshakes.clone());
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { break };
                let current = cfg.lock().expect("cfg").clone();
                let (h, hs) = (h.clone(), hs.clone());
                tokio::spawn(async move {
                    let acceptor = tokio_rustls::TlsAcceptor::from(current);
                    // A refused certificate fails here — that is the point of the test.
                    let Ok(mut stream) = acceptor.accept(sock).await else { return };
                    hs.fetch_add(1, Ordering::SeqCst);
                    if let Some(hit) = read_request(&mut stream).await {
                        h.lock().expect("hits").push(hit);
                        let body = r#"{"cluster_name":"secured","status":"green"}"#;
                        let res = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(res.as_bytes()).await;
                        let _ = stream.shutdown().await;
                    }
                });
            }
        });

        TlsServer { port, config, hits, handshakes }
    }

    /// Present a different certificate from now on, at the same address.
    pub fn rotate_to(&self, cert: &SelfSigned) {
        *self.config.lock().expect("cfg") = server_config(cert);
    }

    pub fn url(&self) -> String {
        format!("https://localhost:{}", self.port)
    }
    pub fn host_key(&self) -> String {
        format!("localhost:{}", self.port)
    }
    /// Handshakes that completed — a refused certificate never gets here.
    pub fn handshakes(&self) -> usize {
        self.handshakes.load(Ordering::SeqCst)
    }
    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().expect("hits").clone()
    }
}
