//! A minimal HTTP/1.1 server on loopback, used to prove what the core actually puts on
//! the wire — and, just as importantly, what it never puts there.
//!
//! Hand-rolled rather than pulled from a crate so that `conns` counts *TCP accepts*:
//! the read-only guard's whole claim is that a blocked request never reaches a socket,
//! and only a connection counter can show that.

#![allow(dead_code)]

pub mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Debug)]
pub struct Hit {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Hit {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }
}

type Responder = Arc<dyn Fn(&Hit) -> (u16, String) + Send + Sync>;

pub struct TestServer {
    pub port: u16,
    hits: Arc<Mutex<Vec<Hit>>>,
    conns: Arc<AtomicUsize>,
}

impl TestServer {
    /// Always answers `200` with `{"ok":true,...}`.
    pub async fn start() -> TestServer {
        Self::with(|_| (200, r#"{"cluster_name":"test","status":"green"}"#.to_string())).await
    }

    pub async fn with<F>(f: F) -> TestServer
    where
        F: Fn(&Hit) -> (u16, String) + Send + Sync + 'static,
    {
        let responder: Responder = Arc::new(f);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let conns = Arc::new(AtomicUsize::new(0));

        let (h, c) = (hits.clone(), conns.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                c.fetch_add(1, Ordering::SeqCst);
                let (h, responder) = (h.clone(), responder.clone());
                tokio::spawn(async move {
                    if let Some(hit) = read_request(&mut sock).await {
                        let (status, body) = responder(&hit);
                        h.lock().expect("hits").push(hit);
                        let reason = if status == 200 { "OK" } else { "Error" };
                        let res = format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = sock.write_all(res.as_bytes()).await;
                        let _ = sock.flush().await;
                    }
                });
            }
        });

        TestServer { port, hits, conns }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// TCP connections accepted so far — 0 proves nothing was sent.
    pub fn connections(&self) -> usize {
        self.conns.load(Ordering::SeqCst)
    }

    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().expect("hits").clone()
    }

    pub fn last_hit(&self) -> Option<Hit> {
        self.hits().last().cloned()
    }
}

pub async fn read_request<S: tokio::io::AsyncRead + Unpin>(sock: &mut S) -> Option<Hit> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    // headers
    let head_end = loop {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut start = lines.next()?.split_whitespace();
    let method = start.next()?.to_string();
    let path = start.next()?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    // body, if the request declared one
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < want {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    Some(Hit { method, path, headers, body: String::from_utf8_lossy(&body).to_string() })
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A loopback port with nothing listening on it — for "connection refused".
pub async fn dead_port() -> u16 {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let p = l.local_addr().expect("addr").port();
    drop(l);
    p
}

/// A scratch directory that removes itself.
pub struct TempDir(pub std::path::PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let p = std::env::temp_dir().join(format!(
            "elasticpro-test-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).expect("mkdir");
        TempDir(p)
    }
    pub fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl TestServer {
    /// Accepts connections and never answers — for timeout classification.
    pub async fn stall() -> TestServer {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let conns = Arc::new(AtomicUsize::new(0));
        let c = conns.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let Ok((sock, _)) = listener.accept().await else { break };
                c.fetch_add(1, Ordering::SeqCst);
                held.push(sock); // keep the socket open, send nothing
            }
        });
        TestServer { port, hits, conns }
    }
}

/// The first account's password on a fresh core, read from the data directory the way an
/// operator reads it. Only there until that password is changed.
pub fn first_password(c: &elasticpro_core::Core) -> String {
    let dir = c.data_dir().expect("a core with a data directory");
    let raw = std::fs::read_to_string(dir.join(elasticpro_core::auth::INITIAL_PASSWORD_FILE))
        .expect("the first password file");
    raw.trim_end().to_string()
}
