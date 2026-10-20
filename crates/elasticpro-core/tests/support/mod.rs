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

/// A server that answers after a delay of the responder's choosing and counts how many
/// requests it is holding at once — the number the gate exists to bound.
pub struct GaugedServer {
    pub port: u16,
    hits: Arc<Mutex<Vec<Hit>>>,
    now: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl GaugedServer {
    /// `f` answers (status, body, delay in ms).
    pub async fn start<F>(f: F) -> GaugedServer
    where
        F: Fn(&Hit) -> (u16, String, u64) + Send + Sync + 'static,
    {
        let f = Arc::new(f);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let now = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (h, n, p) = (hits.clone(), now.clone(), peak.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let (h, n, p, f) = (h.clone(), n.clone(), p.clone(), f.clone());
                tokio::spawn(async move {
                    let Some(hit) = read_request(&mut sock).await else { return };
                    let cur = n.fetch_add(1, Ordering::SeqCst) + 1;
                    p.fetch_max(cur, Ordering::SeqCst);
                    let (status, body, delay) = f(&hit);
                    h.lock().expect("hits").push(hit);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    let res = format!(
                        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        if status == 200 { "OK" } else { "Error" }, body.len()
                    );
                    let _ = sock.write_all(res.as_bytes()).await;
                    let _ = sock.flush().await;
                    n.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        GaugedServer { port, hits, now, peak }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().expect("hits").clone()
    }
    pub fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
    pub fn holding(&self) -> usize {
        self.now.load(Ordering::SeqCst)
    }
}

/// A server whose every answer is a chunked body of `total` bytes, sent a megabyte at a
/// time for as long as the client keeps reading. `declare` sends a Content-Length instead.
/// Returns the port and a counter of bytes actually written.
pub async fn endless_body(total: u64, declare: bool) -> (u16, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let sent = Arc::new(AtomicUsize::new(0));
    let s = sent.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let s = s.clone();
            tokio::spawn(async move {
                if read_request(&mut sock).await.is_none() {
                    return;
                }
                let head = if declare {
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n")
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_string()
                };
                if sock.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                let chunk = vec![b' '; 1024 * 1024];
                let mut left = total;
                while left > 0 {
                    let n = left.min(chunk.len() as u64) as usize;
                    let ok = if declare {
                        sock.write_all(&chunk[..n]).await.is_ok()
                    } else {
                        sock.write_all(format!("{n:x}\r\n").as_bytes()).await.is_ok()
                            && sock.write_all(&chunk[..n]).await.is_ok()
                            && sock.write_all(b"\r\n").await.is_ok()
                    };
                    if !ok {
                        return;
                    }
                    s.fetch_add(n, Ordering::SeqCst);
                    left -= n as u64;
                }
                if !declare {
                    let _ = sock.write_all(b"0\r\n\r\n").await;
                }
            });
        }
    });
    (port, sent)
}
