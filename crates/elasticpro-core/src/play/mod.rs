//! Play, the NOC wall display (docs/PLAY.md, "Core (Rust)").
//!
//! The wall runs the same UI code as every other page; the core adds only what did not
//! exist: display links (`links`), the Play settings (`settings`), node-name history
//! (`nodes`), shared acknowledgements (`acks`) and a shared measurement cache (`share`), plus
//! `PLAY_STATE`, the one small call a wall makes each minute.
//!
//! Where things are kept, all under the data directory, all 0600:
//!
//! | what | file |
//! |---|---|
//! | display links (hosted only; secret hashed) | `play-links.json` |
//! | settings | `play.json` |
//! | shared acknowledgements | `acks.json` |
//! | node-name history, 24 h | `play/nodes.json` |
//! | "open since" per display | `play/open-since.json` |
//! | shared measurements, 48 h | `play/share/<kind>/<hex cluster id>.json` |
//!
//! Every reply that names clusters is cut to the clusters the caller sees
//! (`Caller::sees_cluster`: Zabbix group scope and a display link's own list), and the
//! clusters an administrator excluded from Play are left out of `PLAY_STATE`.

pub mod acks;
pub mod links;
pub mod nodes;
pub mod settings;
pub mod share;

use crate::auth::{Caller, Edition, Role, Session};
use crate::bridge::Core;
use crate::fleet::now_ms;
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Write a file whole, readable by this user only: a temporary file, synced, renamed over.
pub(crate) fn write_private(p: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let wrote = (|| -> std::io::Result<()> {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(body)?;
        f.sync_all()?;
        std::fs::rename(&tmp, p)
    })();
    wrote.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The shared-ack key suffix the wall uses to acknowledge "a node left" on a cluster
/// (`<clusterId>:node-left`, nodeBlink `untilAck`). `PLAY_NODE_FORGET` clears it.
pub const NODE_LEFT_ACK: &str = "node-left";

/// Alert keys a display may hold "open since" times for, at most.
const OPEN_KEYS_MAX: usize = 5000;
/// Displays (links, and people who press ▶ Play) with "open since" times, at most.
const OPEN_DISPLAYS_MAX: usize = 500;

/// When each alert a display shows was first open, kept per display so a reload of the TV
/// keeps "open for 3 h" instead of starting again from zero.
struct OpenSince {
    path: Option<PathBuf>,
    map: Mutex<BTreeMap<String, BTreeMap<String, u64>>>,
}

impl OpenSince {
    fn open(path: Option<PathBuf>) -> OpenSince {
        let map = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        OpenSince { path, map: Mutex::new(map) }
    }

    /// The display's open alerts now (`open`, when it says), and since when each has been.
    fn update(&self, display: &str, open: Option<&[String]>, now: u64) -> BTreeMap<String, u64> {
        let (out, changed) = {
            let mut map = self.map.lock();
            let mut changed = false;
            if let Some(open) = open {
                if !map.contains_key(display) && map.len() >= OPEN_DISPLAYS_MAX {
                    // The display that has gone longest without a new alert makes room.
                    if let Some(k) = map.iter().min_by_key(|(_, m)| m.values().max().copied().unwrap_or(0)).map(|(k, _)| k.clone()) {
                        map.remove(&k);
                    }
                }
                let m = map.entry(display.to_string()).or_default();
                let before = m.len();
                m.retain(|k, _| open.contains(k));
                changed |= m.len() != before;
                for k in open.iter().take(OPEN_KEYS_MAX) {
                    if !m.contains_key(k) {
                        m.insert(k.clone(), now);
                        changed = true;
                    }
                }
            }
            (map.get(display).cloned().unwrap_or_default(), changed)
        };
        if changed {
            if let Some(p) = &self.path {
                if let Ok(body) = serde_json::to_vec(&*self.map.lock()) {
                    let _ = write_private(p, &body);
                }
            }
        }
        out
    }

    fn forget(&self, display: &str) {
        self.map.lock().remove(display);
    }
}

pub struct Play {
    pub(crate) links: links::Links,
    settings_path: Option<PathBuf>,
    pub(crate) settings: RwLock<settings::PlaySettings>,
    pub(crate) nodes: nodes::NodeHistory,
    pub(crate) share: share::Share,
    pub(crate) acks: acks::Acks,
    open_since: OpenSince,
}

impl Play {
    pub fn open(data_dir: Option<&Path>, edition: Edition) -> Play {
        let at = |rel: &str| data_dir.map(|d| d.join(rel));
        let settings_path = at(settings::FILE);
        Play {
            // Display links are a hosted server's: the desktop app has no socket to open one on.
            links: links::Links::open(if edition == Edition::Hosted { at(links::FILE) } else { None }),
            settings: RwLock::new(settings::PlaySettings::load(settings_path.as_deref())),
            settings_path,
            nodes: nodes::NodeHistory::open(data_dir.map(|d| d.join("play").join(nodes::FILE))),
            share: share::Share::open(data_dir.map(|d| d.join("play").join(share::DIR))),
            acks: acks::Acks::open(at(acks::FILE)),
            open_since: OpenSince::open(data_dir.map(|d| d.join("play").join("open-since.json"))),
        }
    }

    fn save_settings(&self, s: &settings::PlaySettings) -> Result<(), String> {
        if let Some(p) = &self.settings_path {
            let body = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
            write_private(p, &body)?;
        }
        *self.settings.write() = s.clone();
        Ok(())
    }

    /// The settings with config.txt applied, and what it locks.
    fn effective(&self) -> (settings::PlaySettings, Vec<&'static str>) {
        settings::resolve(&self.settings.read(), crate::settings::get())
    }

    /// The pinned list for a cluster, when the settings say nodes are expected from it.
    fn pinned_for(&self, eff: &settings::PlaySettings, cluster: &str) -> Option<Vec<String>> {
        (eff.watch.node_expected == "pinned").then(|| eff.watch.pinned.get(cluster).cloned()).flatten()
    }

    /// One completed `nodes` answer, from the fleet poller.
    pub(crate) fn record_nodes(&self, cluster: &str, names: &[String], now: u64) {
        let pinned = self.pinned_for(&self.effective().0, cluster).unwrap_or_default();
        self.nodes.record(cluster, names, &pinned, now);
    }
}

fn s<'a>(msg: &'a Value, k: &str) -> &'a str {
    msg.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn bad(message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": "bad_request", "message": message.into() })
}

/// Messages that reach every cluster (display links, fleet-wide Play settings): only for a
/// caller with no cluster limit.
fn fleet_wide(t: &str) -> bool {
    t.starts_with("PLAY_LINK_") || t == "PLAY_CONFIG_SET"
}

fn forbidden(message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": "forbidden", "message": message.into() })
}

fn who(caller: Option<&Caller>) -> String {
    caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into())
}

impl Core {
    /* ------------------------------ display-link callers ------------------------------ */

    /// Whether display links work here now: the hosted server, and not switched off.
    fn display_links_on(&self) -> bool {
        self.edition() == Edition::Hosted && settings::links_enabled(crate::settings::get())
    }

    /// The caller a live session resolves to. A display-link session lives only as long as
    /// its link (revoked, expired, or links switched off: nobody), and is rebuilt from the
    /// link each time, so a change to the link applies to the TV already showing it.
    pub(crate) fn caller_from_session(&self, s: Session) -> Option<Caller> {
        let Some(link_id) = s.play_link.clone() else {
            return Some(Caller { name: s.user, role: s.role, must_change: s.must_change, scope: s.scope, play: None });
        };
        if !self.display_links_on() {
            return None;
        }
        let link = self.play.links.get(&link_id).filter(|l| !l.expired(now_ms()))?;
        Some(Caller {
            name: link.caller_name(),
            role: Role::User,
            must_change: false,
            scope: link.clusters.scope(),
            play: Some(crate::auth::PlayCaller { link: link.id.clone(), clusters: link.clusters.ids(), allow_from: link.allow_from.clone() }),
        })
    }

    /// A display-link caller asking from an address its link does not allow: the refusal.
    /// Otherwise the use is recorded (`lastSeen`) and `None`.
    pub(crate) fn display_source_refusal(&self, caller: Option<&Caller>, source: Option<std::net::IpAddr>) -> Option<Value> {
        let p = caller.and_then(|c| c.play.as_ref())?;
        if !p.allow_from.is_empty() && !source.is_some_and(|ip| crate::zbx_link::source_allowed(&p.allow_from, ip)) {
            tracing::warn!(target: "audit", user = caller.map(|c| c.name.as_str()).unwrap_or(""), link = %p.link,
                source = ?source, "display link used from an address it does not allow");
            return Some(json!({ "ok": false, "kind": "forbidden", "playOnly": true,
                                "message": "this display link may not be used from this address" }));
        }
        self.play.links.touch(&p.link, now_ms(), source);
        None
    }

    /// `PLAY_EXCHANGE {secret}`: a display link's secret for a session. No session needed:
    /// the secret is the proof. The bridge turns the session into the same HttpOnly cookie a
    /// sign-in gets, and takes it out of the reply.
    pub(crate) fn play_exchange(&self, msg: &Value, source: Option<std::net::IpAddr>) -> Value {
        if self.edition() != Edition::Hosted {
            return json!({ "ok": false, "kind": "unsupported", "message": "display links are the hosted server's" });
        }
        if !settings::links_enabled(crate::settings::get()) {
            return json!({ "ok": false, "kind": "disabled", "message": "display links are switched off on this server (UI_PLAY_ENABLED=false)" });
        }
        let refused = json!({ "ok": false, "kind": "bad_credentials",
                              "message": "that display link is not valid, has expired, or has been revoked — ask an ElasticPro administrator for a new one" });
        let Some(link) = self.play.links.by_secret(s(msg, "secret")) else {
            tracing::warn!(target: "audit", source = ?source, "display link refused: unknown secret");
            return refused;
        };
        if link.expired(now_ms()) {
            tracing::warn!(target: "audit", link = %link.id, name = %link.name, source = ?source, "display link refused: expired");
            return refused;
        }
        if !link.allow_from.is_empty() && !source.is_some_and(|ip| crate::zbx_link::source_allowed(&link.allow_from, ip)) {
            tracing::warn!(target: "audit", link = %link.id, name = %link.name, source = ?source, "display link refused: address not allowed");
            return json!({ "ok": false, "kind": "forbidden", "message": "this display link may not be used from this address" });
        }
        let token = self.sessions.begin_display(&link.caller_name(), link.clusters.scope(), &link.id);
        self.play.links.touch(&link.id, now_ms(), source);
        tracing::info!(target: "audit", user = %link.caller_name(), link = %link.id, source = ?source, "display link opened");
        let caller = Caller {
            name: link.caller_name(), role: Role::User, must_change: false, scope: link.clusters.scope(),
            play: Some(crate::auth::PlayCaller { link: link.id.clone(), clusters: link.clusters.ids(), allow_from: link.allow_from.clone() }),
        };
        json!({ "ok": true, "session": token, "caller": caller.public(), "display": { "id": link.id, "name": link.name } })
    }

    /* ---------------------------------- the messages ---------------------------------- */

    /// Every Play message but `PLAY_EXCHANGE`, and the shared acknowledgements. The gate
    /// has already decided the role (auth::required_role) and, for a display link, the
    /// message (auth::play_may).
    pub(crate) async fn play_msg(self: &Arc<Self>, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        // Display links and the fleet-wide Play settings reach every cluster: a link can be made
        // for all of them, and a watch rule or an exclusion applies on every display. So they are
        // an administrator's with no cluster limit; one limited to some clusters could otherwise
        // hand a TV the clusters it may not see itself.
        if fleet_wide(t) && caller.is_some_and(|c| c.limited()) {
            return forbidden("display links and Play settings need an administrator who sees every cluster");
        }
        match t {
            "PLAY_LINK_CREATE" => self.play_link_create(msg, caller),
            "PLAY_LINK_LIST" => self.play_link_list(),
            "PLAY_LINK_REVOKE" => self.play_link_revoke(msg, caller),
            "PLAY_LINK_SET" => self.play_link_set(msg, caller),
            "PLAY_CONFIG_GET" => self.play_config_get(caller),
            "PLAY_CONFIG_SET" => self.play_config_set(msg, caller),
            "PLAY_NODE_FORGET" => self.play_node_forget(msg, caller),
            "PLAY_STATE" => self.play_state(msg, caller),
            "PLAY_ZOOM_SET" => self.play_zoom_set(msg, caller),
            "PLAY_SHARE_PUT" => self.play_share_put(msg, caller),
            "PLAY_SHARE_GET" => self.play_share_get(msg, caller),
            "ACK_LIST" => self.ack_list(caller),
            "ACK_SET" | "ACK_CLEAR" => self.ack_change(t, msg, caller),
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("Unknown message type {t:?}") }),
        }
    }

    /// Whether this caller sees the cluster with this id (it must exist).
    fn play_sees(&self, caller: Option<&Caller>, id: &str) -> bool {
        self.spec_for(id).is_some_and(|s| caller.is_none_or(|c| c.sees_cluster(&s.id, &s.zabbix_groups)))
    }

    fn play_link_create(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        if !self.display_links_on() {
            return json!({ "ok": false, "kind": if self.edition() == Edition::Hosted { "disabled" } else { "unsupported" },
                           "message": "display links are the hosted server's, and need UI_PLAY_ENABLED (default on)" });
        }
        let now = now_ms();
        let parsed = (|| -> Result<_, String> {
            Ok((links::Clusters::parse(msg.get("clusters"))?, links::parse_allow_from(msg.get("allowFrom"))?,
                links::parse_expires(msg.get("expires"), now)?))
        })();
        let (clusters, allow_from, expires_at) = match parsed {
            Ok(p) => p,
            Err(e) => return bad(e),
        };
        let by = who(caller);
        let (link, secret) = match self.play.links.create(s(msg, "name"), clusters, allow_from, expires_at, &by, now) {
            Ok(x) => x,
            Err(e) => return bad(e),
        };
        // Its display settings, when the page sent them with it.
        if let Some(d) = msg.get("settings").filter(|v| v.is_object()) {
            if let Err(e) = self.play_put_display(&link.id, d) {
                let _ = self.play.links.revoke(&link.id);
                return bad(e);
            }
        }
        tracing::info!(target: "audit", user = %by, link = %link.id, name = %link.name, clusters = %json!(link.clusters),
            allow_from = %link.allow_from.join(","), expires_at = ?link.expires_at, "display link created");
        let base = self.zabbix_link().server().public_url.clone().unwrap_or_default();
        let mut out = link.public(now);
        out["url"] = json!(format!("{}/#/play?display={secret}", base.trim_end_matches('/')));
        json!({ "ok": true, "link": out, "secret": secret })
    }

    fn play_link_list(&self) -> Value {
        let now = now_ms();
        let st = self.play.settings.read().clone();
        let links: Vec<Value> = self.play.links.list().iter().map(|l| {
            let mut v = l.public(now);
            v["sessions"] = json!(self.sessions.display_sessions(&l.id));
            v["settings"] = json!(st.display_for(Some(&l.id)));
            v
        }).collect();
        json!({ "ok": true, "enabled": self.display_links_on(), "links": links })
    }

    fn play_link_revoke(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let id = s(msg, "id");
        match self.play.links.revoke(id) {
            Ok(Some(link)) => {
                let ended = self.sessions.end_display(&link.id);
                let mut st = self.play.settings.read().clone();
                let had_zoom = st.tv_zoom.remove(&link.id).is_some();
                if st.displays.remove(&link.id).is_some() || had_zoom {
                    let _ = self.play.save_settings(&st);
                }
                self.play.open_since.forget(&link.id);
                tracing::info!(target: "audit", user = %who(caller), link = %link.id, name = %link.name, sessions_ended = ended, "display link revoked");
                json!({ "ok": true, "id": link.id, "sessionsEnded": ended })
            }
            Ok(None) => json!({ "ok": false, "kind": "not_found", "message": format!("no display link {id:?}") }),
            Err(e) => json!({ "ok": false, "kind": "io", "message": e }),
        }
    }

    /// A display's settings, merged over what it has (or the default display's).
    fn play_put_display(&self, link: &str, patch: &Value) -> Result<settings::Display, String> {
        let mut st = self.play.settings.read().clone();
        let mut v = serde_json::to_value(st.display_for(Some(link))).map_err(|e| e.to_string())?;
        settings::merge(&mut v, patch);
        let d: settings::Display = serde_json::from_value(v).map_err(|e| format!("settings: {e}"))?;
        d.validate("settings")?;
        st.displays.insert(link.to_string(), d.clone());
        self.play.save_settings(&st)?;
        Ok(d)
    }

    fn play_link_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let id = s(msg, "id");
        if self.play.links.get(id).is_none() {
            return json!({ "ok": false, "kind": "not_found", "message": format!("no display link {id:?}") });
        }
        let Some(patch) = msg.get("settings").filter(|v| v.is_object()) else {
            return bad("settings: the display's settings, an object");
        };
        match self.play_put_display(id, patch) {
            Ok(d) => {
                tracing::info!(target: "audit", user = %who(caller), link = %id, settings = %json!(d), "display settings changed");
                json!({ "ok": true, "id": id, "settings": d })
            }
            Err(e) => bad(e),
        }
    }

    fn play_options() -> Value {
        json!({
            "slides": settings::SLIDES, "spotlightWhen": settings::SPOTLIGHT_WHEN, "zooms": settings::ZOOMS,
            "nodeExpected": settings::NODE_EXPECTED, "nodeBlink": settings::NODE_BLINK,
            "whenEmpty": settings::WHEN_EMPTY, "themes": settings::THEMES, "sounds": settings::SOUNDS,
        })
    }

    /// `PLAY_CONFIG_GET` → `{ok, watch, exclude: [{clusterId, reason, by, at, managed?}],
    /// defaultDisplay, managed: [UI_PLAY_* keys], managedFields, linksEnabled, options}`, and
    /// for an administrator `displays`, `links` and `groups` (the Zabbix user groups the
    /// clusters carry, for the link dialog). Times in ms. Exclusions of clusters the caller
    /// cannot see are left out.
    fn play_config_get(&self, caller: Option<&Caller>) -> Value {
        let (eff, locked) = self.play.effective();
        let managed = crate::settings::get();
        let mut out = json!({
            "ok": true,
            "watch": eff.watch,
            "exclude": eff.exclude.iter().filter(|e| caller.is_none_or(|c| !c.limited()) || self.play_sees(caller, &e.cluster_id))
                .collect::<Vec<_>>(),
            "defaultDisplay": eff.default_display,
            "managed": settings::managed_keys(managed),
            "managedFields": settings::managed_fields(&locked),
            "linksEnabled": self.display_links_on(),
            "options": Core::play_options(),
        });
        // Displays, links and groups span every cluster: the same rule as PLAY_LINK_* — an
        // administrator limited to some clusters sees none of them.
        if caller.is_none_or(|c| c.role >= Role::Admin && !c.limited()) {
            out["displays"] = json!(eff.displays);
            let mut groups: Vec<String> = self.all_specs().into_iter().flat_map(|s| s.zabbix_groups).filter(|g| !g.trim().is_empty()).collect();
            groups.sort();
            groups.dedup();
            out["groups"] = json!(groups);
            if self.edition() == Edition::Hosted {
                out["links"] = self.play_link_list()["links"].clone();
            }
        }
        out
    }

    fn play_config_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(patch) = msg.get("settings") else { return bad("settings: the changes, an object") };
        // A display's settings belong to a link that exists.
        if let Some(d) = patch.get("displays").and_then(Value::as_object) {
            if let Some(stray) = d.keys().find(|id| self.play.links.get(id).is_none()) {
                return bad(format!("displays: no display link {stray:?}"));
            }
        }
        let by = who(caller);
        let current = self.play.settings.read().clone();
        let next = match settings::apply_change(&current, patch, crate::settings::get(), &by, now_ms()) {
            Ok(n) => n,
            Err(e) if e.contains("managed by config.txt") => return json!({ "ok": false, "kind": "managed", "message": e }),
            Err(e) => return bad(e),
        };
        if let Err(e) = self.play.save_settings(&next) {
            return json!({ "ok": false, "kind": "io", "message": format!("the Play settings could not be saved: {e}") });
        }
        let added: Vec<&settings::Exclude> = next.exclude.iter()
            .filter(|e| !current.exclude.iter().any(|o| o.cluster_id == e.cluster_id && o.reason == e.reason)).collect();
        let removed: Vec<&settings::Exclude> = current.exclude.iter().filter(|e| !next.exclude.iter().any(|n| n.cluster_id == e.cluster_id)).collect();
        for e in &added {
            tracing::info!(target: "audit", user = %by, cluster = %e.cluster_id, reason = %e.reason, "cluster excluded from Play");
        }
        for e in &removed {
            tracing::info!(target: "audit", user = %by, cluster = %e.cluster_id, "cluster back on Play");
        }
        if next.watch != current.watch || next.default_display != current.default_display || next.displays != current.displays {
            tracing::info!(target: "audit", user = %by, watch = %json!(next.watch), "Play settings changed");
        }
        self.play_config_get(caller)
    }

    fn play_node_forget(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let (id, node) = (s(msg, "clusterId"), s(msg, "node"));
        if node.is_empty() {
            return bad("node: the name of the node removed on purpose");
        }
        if !self.play_sees(caller, id) {
            return forbidden(format!("cluster {id:?} is not one of yours"));
        }
        let known = self.play.nodes.forget(id, node, now_ms());
        // Pinned, it would be expected again at once.
        let mut st = self.play.settings.read().clone();
        let mut unpinned = false;
        if let Some(list) = st.watch.pinned.get_mut(id) {
            let before = list.len();
            list.retain(|n| n != node);
            unpinned = list.len() != before;
        }
        if unpinned {
            let _ = self.play.save_settings(&st);
        }
        if !known && !unpinned {
            return json!({ "ok": false, "kind": "not_found", "message": format!("{node:?} is not a node Play knows on {id:?}") });
        }
        // The wall's "node left" acknowledgement (nodeBlink: untilAck) is about what was missing;
        // with a node forgotten that has changed, so it goes too.
        let ack_key = format!("{id}:{NODE_LEFT_ACK}");
        let ack_cleared = matches!(self.play.acks.clear(&ack_key), Ok(Some(_)));
        tracing::info!(target: "audit", user = %who(caller), cluster = %id, node = %node, ack_cleared, "node forgotten by Play");
        json!({ "ok": true, "clusterId": id, "node": node, "ackCleared": ack_cleared })
    }

    /// `PLAY_ZOOM_SET {zoom}`: a display link's TV saving its own − / +. Kept per link
    /// (`tvZoom`) and handed back by `PLAY_STATE` as `zoom`, unless the administrator fixed
    /// the display's zoom, which then wins. Only a display link keeps its zoom on the server;
    /// a person's stays in their browser.
    fn play_zoom_set(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let Some(link) = caller.and_then(|c| c.play.as_ref()).map(|p| p.link.clone()) else {
            return bad("only a display link keeps its zoom on the server; a person's stays in the browser");
        };
        let Some(z) = msg.get("zoom").and_then(Value::as_f64) else { return bad("zoom: one of 0.8, 0.9, 1, 1.1, 1.25, 1.5") };
        if let Err(e) = settings::check_zoom("zoom", z) {
            return bad(e);
        }
        let mut st = self.play.settings.read().clone();
        if st.tv_zoom.get(&link).is_none_or(|old| (old - z).abs() > 1e-9) {
            st.tv_zoom.insert(link.clone(), z);
            if let Err(e) = self.play.save_settings(&st) {
                return json!({ "ok": false, "kind": "io", "message": e });
            }
        }
        json!({ "ok": true, "zoom": st.zoom_for(Some(&link)), "fixed": st.display_for(Some(&link)).zoom.is_some() })
    }

    /// `PLAY_STATE {open?: [alertKey]}` → `{settings: {watch, display}, zoom, excluded, nodes,
    /// openSince, now}`.
    ///
    /// `open`: the alerts this display shows open now; each keeps the time it was first
    /// sent, per display, so a reload keeps "open for". `zoom`: what the display shows at —
    /// the administrator's when fixed, else what its TV last saved, else 1.
    fn play_state(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let now = now_ms();
        let link = caller.and_then(|c| c.play.as_ref()).map(|p| p.link.clone());
        let (eff, _) = self.play.effective();
        let excluded = eff.excluded();
        let visible: Vec<String> = self.fleet_visible(caller);
        let mut nodes = Map::new();
        for id in visible.iter().filter(|id| !excluded.contains(id)) {
            let pinned = self.play.pinned_for(&eff, id);
            if let Some(mut st) = self.play.nodes.state(id, pinned.as_deref(), now) {
                // "Left" holds while the cluster answers; one that does not is its own problem.
                let answering = self.fleet.state.lock().reach_state(id) != crate::fleet::entry::ReachState::Unreachable;
                st["answering"] = json!(answering);
                if !answering {
                    st["left"] = json!([]);
                }
                nodes.insert(id.clone(), st);
            }
        }
        let display_key = match (&link, caller) {
            (Some(l), _) => l.clone(),
            (None, Some(c)) => format!("user:{}", c.name),
            (None, None) => "user:local".into(),
        };
        let open: Option<Vec<String>> = msg.get("open").and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).filter(|k| !k.is_empty() && k.len() <= acks::MAX_KEY).collect());
        let open_since = self.play.open_since.update(&display_key, open.as_deref(), now);
        json!({
            "ok": true,
            "settings": { "watch": eff.watch, "display": eff.display_for(link.as_deref()) },
            "zoom": eff.zoom_for(link.as_deref()),
            "excluded": excluded.iter().filter(|id| caller.is_none_or(|c| !c.limited()) || visible.contains(id)).collect::<Vec<_>>(),
            "nodes": nodes,
            "openSince": open_since,
            "now": now,
        })
    }

    fn play_share_put(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let (kind, id) = (s(msg, "kind"), s(msg, "clusterId"));
        if let Err(e) = share::check_kind(kind) {
            return bad(e);
        }
        if !self.play_sees(caller, id) {
            return forbidden(format!("cluster {id:?} is not one of yours"));
        }
        let Some(measured_at) = msg.get("measuredAt").and_then(Value::as_u64) else {
            return bad("measuredAt: when it was measured, ms since the epoch");
        };
        let data = msg.get("data").cloned().unwrap_or(Value::Null);
        match self.play.share.put(kind, id, measured_at, data, &who(caller), now_ms()) {
            Ok(kept) => json!({ "ok": true, "kind": kind, "clusterId": id, "kept": kept }),
            Err(e) => bad(e),
        }
    }

    fn play_share_get(&self, msg: &Value, caller: Option<&Caller>) -> Value {
        let kind = s(msg, "kind");
        if let Err(e) = share::check_kind(kind) {
            return bad(e);
        }
        let visible = self.fleet_visible(caller);
        let ids: Vec<String> = match msg.get("clusterIds").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(Value::as_str).filter(|id| visible.iter().any(|v| v == id)).map(String::from).collect(),
            None => visible,
        };
        json!({ "ok": true, "kind": kind, "records": self.play.share.get(kind, &ids, now_ms()), "keepHours": share::KEEP_MS / 3_600_000 })
    }

    /// Whether this caller may see the acknowledgement under `key`: the cluster its key
    /// names (`<clusterId>:…`, the longest known id) must be theirs. A caller limited to some
    /// clusters sees nothing whose cluster is not known.
    fn ack_visible(&self, caller: Option<&Caller>, key: &str, known: &[String], visible: &[String]) -> bool {
        if caller.is_none_or(|c| !c.limited()) {
            return true;
        }
        crate::silences::cluster_of("alert", key, known).is_some_and(|id| visible.contains(id))
    }

    fn ack_list(&self, caller: Option<&Caller>) -> Value {
        let known: Vec<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        let visible = self.fleet_visible(caller);
        let acks: Map<String, Value> = self.play.acks.list().into_iter()
            .filter(|(k, _)| self.ack_visible(caller, k, &known, &visible))
            .map(|(k, a)| (k, json!(a))).collect();
        json!({ "ok": true, "acks": acks })
    }

    fn ack_change(&self, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        let key = s(msg, "key");
        let known: Vec<String> = self.all_specs().into_iter().map(|s| s.id).collect();
        let visible = self.fleet_visible(caller);
        if !key.is_empty() && !self.ack_visible(caller, key, &known, &visible) {
            return forbidden("that alert is on a cluster you cannot see");
        }
        let by = who(caller);
        if t == "ACK_SET" {
            let note = msg.get("note").and_then(Value::as_str);
            match self.play.acks.set(key, note, msg.get("record"), &by, now_ms()) {
                Ok(a) => {
                    tracing::info!(target: "audit", user = %by, key = %key, acked = a.acked(), note_chars = a.note.as_ref().map(|n| n.chars().count()).unwrap_or(0),
                        "alert acknowledgement set");
                    json!({ "ok": true, "key": key, "ack": a })
                }
                Err(e) => bad(e),
            }
        } else {
            match self.play.acks.clear(key) {
                Ok(Some(_)) => {
                    tracing::info!(target: "audit", user = %by, key = %key, "alert acknowledgement cleared");
                    json!({ "ok": true, "key": key })
                }
                Ok(None) => json!({ "ok": true, "key": key, "cleared": false }),
                Err(e) => bad(e),
            }
        }
    }
}

#[cfg(test)]
mod scope_tests {
    use super::fleet_wide;
    use crate::auth::{Caller, Role};

    #[test]
    fn display_links_and_settings_need_an_unlimited_caller() {
        for t in ["PLAY_LINK_CREATE", "PLAY_LINK_LIST", "PLAY_LINK_REVOKE", "PLAY_LINK_SET", "PLAY_CONFIG_SET"] {
            assert!(fleet_wide(t), "{t} reaches every cluster");
        }
        for t in ["PLAY_STATE", "PLAY_CONFIG_GET", "PLAY_NODE_FORGET", "PLAY_SHARE_GET", "ACK_SET"] {
            assert!(!fleet_wide(t), "{t} is scoped per cluster instead");
        }
        let scoped = Caller { name: "ops@zabbix".into(), role: Role::Admin, must_change: false, scope: Some(vec!["Team A".into()]), play: None };
        let full = Caller { name: "admin".into(), role: Role::Admin, must_change: false, scope: None, play: None };
        assert!(scoped.limited(), "an administrator limited to some host groups is refused");
        assert!(!full.limited(), "one who sees every cluster is not");
    }
}
