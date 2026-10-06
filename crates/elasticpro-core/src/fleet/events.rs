//! Telling open pages that the cache changed, instead of having each of them ask.
//!
//! The hosted bridge streams these as server-sent events at `GET /events`. An
//! `EventSource` cannot set a header and a session token does not belong in a URL that
//! nginx logs, so the stream is opened with a ticket: single-use, sixty seconds, obtained
//! over the authenticated message API. The ticket remembers how its caller proved who
//! they were, so the stream can ask again every minute and close when the answer changes.

use super::catalogue::Dataset;
use crate::auth::Caller;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const TICKET_TTL: Duration = Duration::from_secs(60);
/// How often an open stream re-checks the session behind it.
pub const REVALIDATE: Duration = Duration::from_secs(60);

/// How a caller was established — and therefore how to establish them again.
#[derive(Clone, Debug)]
pub enum Reauth {
    /// A session token from LOGIN or the Zabbix sign-in.
    Session(String),
    /// An API token (`Authorization: Bearer`).
    Token(String),
    /// A name a trusted proxy vouched for.
    Proxy(String),
    /// Nothing: an edition with no accounts.
    None,
}

#[derive(Clone, Debug)]
pub struct EventsOwner {
    pub caller: Option<Caller>,
    pub reauth: Reauth,
}

#[derive(Default)]
pub struct Tickets {
    map: Mutex<HashMap<String, (Instant, EventsOwner)>>,
}

impl Tickets {
    pub fn issue(&self, owner: EventsOwner) -> String {
        let t = crate::auth::random_hex(24);
        let mut m = self.map.lock();
        m.retain(|_, (at, _)| at.elapsed() < TICKET_TTL);
        m.insert(t.clone(), (Instant::now(), owner));
        t
    }

    /// The owner, once. A second redeem of the same ticket — a replay from a log or a
    /// browser history — gets nothing.
    pub fn redeem(&self, ticket: &str) -> Option<EventsOwner> {
        let (at, owner) = self.map.lock().remove(ticket)?;
        (at.elapsed() < TICKET_TTL).then_some(owner)
    }
}

/// One change, as the stream sends it.
#[derive(Clone, Debug)]
pub struct FleetEvent {
    pub cluster_id: String,
    /// `None` for a reach change.
    pub dataset: Option<Dataset>,
    pub payload: Value,
}

impl FleetEvent {
    /// The SSE event name: `dataset` or `reach`.
    pub fn name(&self) -> &'static str {
        if self.dataset.is_some() { "dataset" } else { "reach" }
    }
}
