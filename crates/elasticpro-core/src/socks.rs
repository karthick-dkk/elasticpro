//! In-process SOCKS5 listener (CONNECT only, no auth, loopback only).
//!
//! reqwest speaks `socks5h://` natively, so the cleanest way to route one cluster's
//! HTTP client through an SSH channel is to give it a SOCKS proxy whose every CONNECT
//! becomes a `direct-tcpip` channel on the jump host. The listener binds 127.0.0.1 on
//! an ephemeral port that nothing else on the machine is told about.

use crate::ssh::Tunnel;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct SocksServer {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for SocksServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start(tunnel: Arc<Tunnel>) -> std::io::Result<SocksServer> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let port = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let t = tunnel.clone();
                    tokio::spawn(async move {
                        if let Err(e) = serve(stream, t).await {
                            tracing::debug!("socks session ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!("socks accept failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });
    Ok(SocksServer { port, task })
}

async fn serve(mut s: TcpStream, tunnel: Arc<Tunnel>) -> std::io::Result<()> {
    // greeting
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(bad("not socks5"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    s.write_all(&[5, 0]).await?; // no auth

    // request
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?; // command not supported
        return Err(bad("only CONNECT"));
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            let mut n = vec![0u8; l[0] as usize];
            s.read_exact(&mut n).await?;
            String::from_utf8_lossy(&n).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(bad("address type"));
        }
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await?;
    let port = u16::from_be_bytes(p);

    match tunnel.open(&host, port).await {
        Ok(mut remote) => {
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let _ = tokio::io::copy_bidirectional(&mut s, &mut remote).await;
            Ok(())
        }
        Err(e) => {
            // 0x05 connection refused / 0x01 general failure — reqwest surfaces both as a proxy error;
            // the HTTP layer reads the tunnel state for the real reason.
            let code = match e.kind() {
                "forward" => 5,
                _ => 1,
            };
            s.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            Err(bad(&e.to_string()))
        }
    }
}

fn bad(msg: &str) -> std::io::Error {
    std::io::Error::other(msg.to_string())
}
