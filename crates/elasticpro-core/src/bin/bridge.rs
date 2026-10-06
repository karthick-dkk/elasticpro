//! HTTP bridge: serves the UI folder and exposes the core's message API at POST /bridge,
//! so the whole app runs in a normal browser without a WebView.
//!
//! Two modes, and the difference matters:
//!
//! * **Development** (default): binds loopback, no authentication. One person, one
//!   machine, nothing else can reach it.
//! * **Hosted** (`ELASTICPRO_BIND` set to a non-loopback address): accounts apply, and the
//!   core authenticates people itself — a first administrator is created on first run and
//!   everyone signs in against `users.json`. An API token identifies a machine.
//!
//! A reverse proxy may still authenticate at the edge and pass a name in `X-Auth-User`.
//! That header is trusted, so it is only as good as the proxy in front of it, and it is
//! now only one of three ways to be somebody rather than the only one — it grants
//! whatever role that name has an account for, and nothing at all if it has none.

use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::{http::HeaderMap, routing::{get, post}, Json, Router};
use elasticpro_core::auth::{Caller, Edition};
use elasticpro_core::fleet::events::{EventsOwner, FleetEvent, Reauth, REVALIDATE};
use elasticpro_core::Core;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

/// The header a trusted proxy sets after authenticating the user.
pub const USER_HEADER: &str = "x-auth-user";

/// Message types that change something and are therefore audited by user.
const AUDITED: &[&str] = &["ES", "WRITE_UNLOCK", "TRUST_CERT", "UNTRUST_CERT", "TRUST_HOSTKEY",
                           "UNTRUST_HOSTKEY", "CONFIG_WRITE", "FILE_WRITE", "FORGET",
                           "ZABBIX_LINK_SET", "ZABBIX_PAIR_BEGIN", "ZABBIX_UNPAIR"];

struct App {
    core: Arc<Core>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let ui = std::env::args().nth(1).unwrap_or_else(|| "ui".into());
    let port: u16 = std::env::args().nth(2).and_then(|p| p.parse().ok()).unwrap_or(8765);
    let data = std::env::var("ELASTICPRO_DATA_DIR").ok().map(std::path::PathBuf::from);

    // Loopback unless told otherwise. A non-loopback bind switches on the user requirement.
    let bind: std::net::IpAddr = std::env::var("ELASTICPRO_BIND").ok()
        .and_then(|b| b.parse().ok())
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));
    let hosted = !bind.is_loopback();
    if hosted {
        tracing::warn!(bind = %bind, "hosted mode: accounts required — a fresh install creates the first one with a password of its own");
    }

    // The dev bridge on loopback is a single person on their own machine, exactly like
    // the portable build; a non-loopback bind is the hosted deployment.
    let edition = if hosted { Edition::Hosted } else { Edition::Portable };
    let core = Core::new(data, edition);
    // The one timer in the product. It is started here, inside the runtime and only for
    // the hosted binary, rather than in Core::new — a scheduler that starts itself
    // wherever a Core is built would run in the desktop app and in every test.
    core.start_delay_sink();
    // The last cluster setup an admin applied, so a restart does not leave everybody
    // else on "not primed" until an admin next opens the app.
    core.restore_prime().await;
    // Clusters that are Zabbix hosts: once now, so they are there on the first page load,
    // then on a timer.
    if core.edition() == Edition::Hosted {
        let first = core.zabbix_sync().await;
        if first["kind"] != "not_configured" {
            tracing::info!(result = %first, "zabbix sync at start");
        }
    }
    core.start_zabbix_sync();
    // After the prime and the first Zabbix sync, so the poller starts knowing the clusters
    // it is to poll and does not prune a restored cache it has not been told about yet.
    core.start_fleet_poller();
    let app = Router::new()
        .route("/bridge", post(bridge))
        // Fleet cache changes, pushed. Opened with a ticket from EVENTS_TICKET; see events().
        .route("/events", get(events))
        // Server to server, from the Zabbix module: signed with HMAC, rate-limited here and
        // in nginx, and limited to `allowedSources` when those are set. nginx forwards
        // exactly these two paths (with X-Real-IP); the module may also reach the core
        // directly on the ep_sso network. See zbx_sso.rs and zbx_link.rs.
        .route("/sso/zabbix", post(zabbix_sso).layer(axum::extract::DefaultBodyLimit::max(64 * 1024)))
        .route("/zabbix/pair", post(zabbix_pair).layer(axum::extract::DefaultBodyLimit::max(64 * 1024)))
        .fallback_service(ServeDir::new(&ui))
        .layer(axum::middleware::from_fn_with_state(core.clone(), frame_ancestors))
        .with_state(Arc::new(App { core }));
    let addr = std::net::SocketAddr::from((bind, port));
    println!("elasticpro-bridge: http://{addr}/  (ui from {ui}){}", if hosted { "  [hosted: accounts required]" } else { "" });
    let l = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(l, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.expect("serve");
}

/// Who may show this app in a frame: the paired Zabbix frontend, or nobody. Set here
/// rather than in nginx because only the core knows what it is paired with; a value the
/// server's configuration sets (`ELASTICPRO_FRAME_ANCESTORS`) still wins. Every other security
/// header stays nginx's.
async fn frame_ancestors(
    State(core): State<Arc<Core>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut res = next.run(req).await;
    let v = format!("frame-ancestors {}", core.frame_ancestors());
    let v = axum::http::HeaderValue::from_str(&v)
        .unwrap_or_else(|_| axum::http::HeaderValue::from_static("frame-ancestors 'none'"));
    res.headers_mut().insert(axum::http::header::CONTENT_SECURITY_POLICY, v);
    res
}

/// Where a server-to-server request came from, as the link's trust rules decide.
fn source_of(app: &App, headers: &HeaderMap, peer: std::net::SocketAddr) -> Option<std::net::IpAddr> {
    let real = headers.get("x-real-ip").and_then(|v| v.to_str().ok());
    app.core.zabbix_link().effective_source(real, Some(peer.ip()))
}

fn status(code: u16) -> axum::http::StatusCode {
    axum::http::StatusCode::from_u16(code).unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

/// The signature is over the exact bytes received, so the body is taken raw rather than
/// through `Json`, which would re-serialise it.
async fn zabbix_sso(
    State(app): State<Arc<App>>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    let sig = headers.get("x-zabbix-module-signature").and_then(|v| v.to_str().ok()).unwrap_or("");
    let (code, out) = app.core.zabbix_sso_init_from(&body, sig, source_of(&app, &headers, peer));
    (status(code), Json(out))
}

/// `POST /zabbix/pair` — the same header, the same signature scheme, the pairing secret.
async fn zabbix_pair(
    State(app): State<Arc<App>>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    let sig = headers.get("x-zabbix-module-signature").and_then(|v| v.to_str().ok()).unwrap_or("");
    let (code, out) = app.core.zabbix_pair(&body, sig, source_of(&app, &headers, peer));
    (status(code), Json(out))
}

async fn bridge(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(msg): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let user = headers.get(USER_HEADER).and_then(|v| v.to_str().ok()).map(str::trim).filter(|u| !u.is_empty());

    // An API token stands on its own: it is a secret this core issued and can revoke, so
    // unlike the user header it does not need the proxy to have vouched for anything.
    // That is what lets Zabbix and scripts in without an account or a password.
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty());

    // No blanket rejection for a request carrying no header.
    //
    // There used to be one, from when the proxy was the only thing that could identify
    // anybody. The core authenticates people itself now, and that rejection fired before
    // the session was even looked at — so with nginx's basic auth removed the login
    // screen could never have called LOGIN, and the app could never have let anyone in.
    //
    // Nothing is lost by dropping it: every message that needs a role goes through
    // `gate()`, which refuses an unidentified caller with the same "unauthenticated".
    // What is left open is exactly the handful that must be — PING, WHOAMI, LOGIN — which
    // is what a sign-in screen is made of.

    // Three ways to be somebody here, most explicit first.
    //
    // An API token is a deliberate act: something presenting one is asking to be that
    // token, not whoever's proxy session it travelled on. A session token is next — it
    // means a person signed in through the app itself, which is a stronger statement than
    // the ambient identity a proxy attaches to every request. The proxy header is the
    // fallback, for a deployment that still authenticates at the edge.
    //
    // Which of the three it was is kept alongside, so an event stream opened on the
    // strength of this request can ask the same question again later.
    let (caller, reauth): (Option<Caller>, Reauth) = match bearer {
        Some(secret) => match app.core.caller_for_token(secret) {
            Some(c) => (Some(c), Reauth::Token(secret.to_string())),
            None => {
                return Json(serde_json::json!({
                    "ok": false, "kind": "unauthenticated",
                    "message": "that API token is not valid, has expired, or has been revoked",
                }))
            }
        },
        None => {
            let session = msg.get("session").and_then(|v| v.as_str());
            match session.and_then(|s| app.core.caller_for_session(s)) {
                Some(c) => (Some(c), Reauth::Session(session.unwrap_or_default().to_string())),
                None => match user.and_then(|u| app.core.caller_for_proxy_user(u)) {
                    Some(c) => (Some(c), Reauth::Proxy(user.unwrap_or_default().to_string())),
                    None => (None, Reauth::None),
                },
            }
        }
    };

    let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let out = app.core.handle_as_from(msg.clone(), caller.clone(), reauth).await;

    // The audit line: who did what to which cluster, and whether it went through. This
    // is the record that answers "who deleted that index".
    if AUDITED.contains(&t.as_str()) {
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let is_read = t == "ES" && (method.is_empty() || method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD"));
        if !is_read {
            tracing::info!(
                target: "audit",
                // The resolved caller, so a write made with an API token is attributed to
                // the token rather than to whoever's proxy session it rode in on.
                user = caller.as_ref().map(|c| c.name.as_str()).or(user).unwrap_or("-"),
                role = caller.as_ref().map(|c| c.role.as_str()).unwrap_or("-"),
                msg_type = %t,
                cluster = msg.get("clusterId").and_then(|v| v.as_str()).unwrap_or("-"),
                method = method,
                path = msg.get("path").and_then(|v| v.as_str()).unwrap_or(""),
                ok = out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                kind = out.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
                "write"
            );
        }
    }
    Json(out)
}

/// What one open event stream carries between events.
struct Stream {
    core: Arc<Core>,
    owner: EventsOwner,
    /// Who the owner is now — refreshed at every re-check, so a role or scope change
    /// narrows the stream without reconnecting.
    caller: Option<Caller>,
    rx: broadcast::Receiver<FleetEvent>,
    next_check: tokio::time::Instant,
    /// The `hello` event has gone out.
    greeted: bool,
    done: bool,
}

/// `GET /events?ticket=…` — the fleet cache's changes as server-sent events.
///
/// `event: dataset` `{clusterId, dataset, seq, status, fetchedAt}` and `event: reach`
/// `{clusterId, seq, reach}`, only for clusters the caller may see (and for a guest, only
/// the datasets a guest may read). The page then asks FLEET_STATE {since} for the bodies:
/// the stream says what changed, never what it changed to, so it carries nothing the
/// message API would not. The first event is `hello` `{epoch, seq}`.
///
/// The ticket is single-use and lives sixty seconds. Every minute the stream re-checks
/// the session behind it and closes with `event: expired` when it has ended. A stream
/// that fell behind gets `event: resync` and should fetch FLEET_STATE in full.
async fn events(State(app): State<Arc<App>>, Query(q): Query<HashMap<String, String>>) -> axum::response::Response {
    let owner = q.get("ticket").and_then(|t| app.core.redeem_events_ticket(t));
    let Some(owner) = owner else {
        return (axum::http::StatusCode::UNAUTHORIZED, "the ticket is unknown, used or expired: ask EVENTS_TICKET for a new one")
            .into_response();
    };
    app.core.fleet_touch();
    let st = Stream {
        core: app.core.clone(),
        caller: owner.caller.clone(),
        owner,
        rx: app.core.fleet_subscribe(),
        next_check: tokio::time::Instant::now() + REVALIDATE,
        greeted: false,
        done: false,
    };
    let stream = futures_util::stream::unfold(st, |mut st| async move {
        if st.done {
            return None;
        }
        // First: which run of the core this is, and where its seq stands. A client whose
        // stored epoch differs asks FLEET_STATE in full rather than {since}.
        if !st.greeted {
            st.greeted = true;
            let hello = serde_json::json!({ "epoch": st.core.fleet_epoch(), "seq": st.core.fleet_seq() });
            return Some((Ok::<_, std::convert::Infallible>(Event::default().event("hello").data(hello.to_string())), st));
        }
        loop {
            tokio::select! {
                r = st.rx.recv() => match r {
                    Ok(ev) => {
                        if st.core.fleet_event_visible(st.caller.as_ref(), &ev) {
                            let e = Event::default().event(ev.name()).data(ev.payload.to_string());
                            return Some((Ok(e), st));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let r = serde_json::json!({ "epoch": st.core.fleet_epoch(), "seq": st.core.fleet_seq() });
                        return Some((Ok(Event::default().event("resync").data(r.to_string())), st));
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
                _ = tokio::time::sleep_until(st.next_check) => {
                    match st.core.events_revalidate(&st.owner) {
                        Some(c) => {
                            st.caller = c;
                            st.next_check = tokio::time::Instant::now() + REVALIDATE;
                            // An open stream is somebody looking.
                            st.core.fleet_touch();
                        }
                        None => {
                            st.done = true;
                            return Some((Ok(Event::default().event("expired").data("{}")), st));
                        }
                    }
                }
            }
        }
    });
    // nginx buffers proxied responses by default, which holds events back until the
    // buffer fills; this header turns that off for this response alone.
    (
        [("x-accel-buffering", "no")],
        Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(20))),
    )
        .into_response()
}
