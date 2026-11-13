//! A Zabbix host at the address of a cluster ElasticPro already has: held for an administrator's
//! review, never taken over silently.
//!
//! **Identity is the address** (`url_identity`): scheme, host and port, with any path, without a
//! trailing slash, case or credential, and with the scheme's default port written out
//! (`https://es` is `https://es:443`). It is the one definition: the sync compares with it, and the
//! pages get it from the core (`identity` on every held entry) instead of keeping a copy.
//!
//! When a sync finds a Zabbix host whose identity is an existing cluster's — a config-file cluster,
//! or another Zabbix host already in use — nothing about that cluster changes. The host is **held**:
//! not polled, not listed among the clusters, and recorded here with both sides' values. Hosts that
//! do not conflict keep syncing as before. An administrator decides, per host
//! (`ZABBIX_CONFLICT_DECIDE`):
//!
//! * **skip** — the host stays out; the existing cluster stays as it is;
//! * **update** — the host takes the cluster over: a config-file cluster is set aside (the pages
//!   no longer use it), a Zabbix host already in use is no longer built;
//! * **keep both** — both are clusters, each with its own id.
//!
//! A decision is kept with the Zabbix values it was made on (`fingerprint`). A sync that finds the
//! same values applies it without asking again; one that finds them changed keeps applying it and
//! asks again (`state: "changed"`) until an administrator confirms. A conflict that is no longer
//! there (the host moved, the existing cluster went away) forgets an undecided entry and keeps a
//! decided one, which applies again if the same conflict comes back.
//!
//! **The first build with no file** — the first sync after an upgrade from a release without
//! review — records what the pages did until then, so the upgrade itself changes nothing: a
//! config-file cluster at the same address *as the earlier rule compared it* (trailing slash and
//! case only) was set aside, so that is **update**; any other conflict (one that differs only by a
//! default port, or two Zabbix hosts at one address) had both in use, so that is **keep both**. Each
//! is listed as decided `by` [`BEFORE_REVIEW`] and can be changed like any other.
//!
//! Which side is the existing one: a config-file cluster, always. Between Zabbix hosts, the one a
//! kept entry names, else the one the last build used, else the oldest (lowest host id).
//!
//! Hosted only: `<data dir>/zabbix-conflicts.json`, 0600, written tmp + rename. The core writes it;
//! the report worker reads it again when it changes and never writes it.

use crate::cluster_save::Refusal;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

/// The store's file name in the data directory.
pub const FILE: &str = "zabbix-conflicts.json";
/// Stops one runaway Zabbix filling the file.
pub const MAX_ENTRIES: usize = 5000;
/// Who decided a conflict recorded at the first build: the pages' rule before review existed.
pub const BEFORE_REVIEW: &str = "as before review existed";
/// Who decided a conflict for a host `createHosts` made from a config-file cluster: the admin who
/// turned that option on asked for exactly this host.
pub const CREATE_HOSTS: &str = "createHosts";

/* ------------------------------------------ identity ------------------------------------------ */

/// The identity of an Elasticsearch address: `scheme://host:port[/path]`, lower-case, the
/// scheme's default port written out (http 80, https 443), no credential, query or fragment, no
/// trailing slash. `None` for something that is not an http(s) address.
pub fn url_identity(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default: u16 = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let authority = authority.rsplit('@').next().unwrap_or("");
    let port_of = |p: &str| -> Option<u16> { if p.is_empty() { Some(default) } else { p.parse::<u16>().ok() } };
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        let port = match after {
            "" => default,
            p => port_of(p.strip_prefix(':')?)?,
        };
        (format!("[{}]", h.to_ascii_lowercase()), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), port_of(p)?),
            None => (authority.to_ascii_lowercase(), default),
        }
    };
    let host = host.trim_end_matches('.').to_string();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let path = tail.split(['?', '#']).next().unwrap_or("").trim_end_matches('/').to_ascii_lowercase();
    Some(format!("{scheme}://{host}:{port}{path}"))
}

/// The key two addresses are compared by: the identity, or — for something that is not an
/// http(s) address, which cannot be normalised — the text itself without case or a trailing slash,
/// so an exact duplicate still matches.
pub fn url_key(url: &str) -> String {
    url_identity(url).unwrap_or_else(|| legacy_key(url))
}

/// The address as written, with any `user:password@` taken out: what the review shows.
pub fn without_credential(url: &str) -> String {
    let t = url.trim();
    let Some((scheme, rest)) = t.split_once("://") else { return t.to_string() };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..end].rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://{host}{}", &rest[end..]),
        None => t.to_string(),
    }
}

/// How the pages compared addresses before review existed (ui/js/core/config.js `urlKey` up to
/// 0.3.59): only the trailing slash and case. Read once, by the first build's record of what was
/// in place ([`BEFORE_REVIEW`]).
pub fn legacy_key(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

/* ------------------------------------------ the record ------------------------------------------ */

/// What an administrator decided about one held host.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Skip,
    Update,
    KeepBoth,
}

impl Decision {
    pub fn parse(s: &str) -> Option<Decision> {
        match s.trim() {
            "skip" => Some(Decision::Skip),
            "update" => Some(Decision::Update),
            "keepBoth" | "keep_both" => Some(Decision::KeepBoth),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Skip => "skip",
            Decision::Update => "update",
            Decision::KeepBoth => "keepBoth",
        }
    }
}

/// The cluster a held host is at the address of.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Against {
    /// `config` (a config-file cluster) or `zabbix` (another Zabbix host).
    pub kind: String,
    /// Its cluster id.
    pub id: String,
    /// Its Zabbix host id, for a Zabbix host; "" for a config-file cluster.
    #[serde(default)]
    pub host_id: String,
}

/// One held host, keyed by its Zabbix host id.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The host's technical name when last seen.
    pub host: String,
    pub identity: String,
    pub against: Against,
    pub first_seen: u64,
    /// Zabbix's values when last seen, and their fingerprint.
    pub values: Value,
    pub fingerprint: String,
    #[serde(default)]
    pub decision: Option<Decision>,
    #[serde(default)]
    pub decided_by: String,
    #[serde(default)]
    pub decided_at: u64,
    /// The fingerprint the decision was made on; "" for one made before the host was first seen
    /// (`createHosts`), which takes the first values seen.
    #[serde(default)]
    pub decided_fingerprint: String,
    #[serde(default)]
    pub decided_values: Value,
}

impl Entry {
    /// `pending` (nobody decided), `decided` (applied, values as decided) or `changed` (applied,
    /// but Zabbix's values moved since: asked again).
    pub fn state(&self) -> &'static str {
        match self.decision {
            None => "pending",
            Some(_) if self.decided_fingerprint == self.fingerprint => "decided",
            Some(_) => "changed",
        }
    }
}

/// Zabbix's values as the review shows them, and their fingerprint: what "the Zabbix values
/// changed" means. Only what Zabbix says about the host — never what ElasticPro laid over it.
pub fn fingerprint(values: &Value) -> String {
    let mut h = Sha256::new();
    h.update(values.to_string().as_bytes());
    hex::encode(&h.finalize()[..12])
}

/* ------------------------------------------ resolving ------------------------------------------ */

/// A cluster that exists already, as the review compares it.
#[derive(Clone, Debug)]
pub struct Known {
    pub kind: &'static str,
    pub id: String,
    pub host_id: String,
    pub identity: String,
    pub legacy: String,
    /// What the review shows of it: `name`, `url`, `via`, `tls`, `tags`, `enabled`, `username`.
    pub values: Value,
}

/// A host the sync found.
#[derive(Clone, Debug)]
pub struct Found {
    pub host_id: String,
    pub host: String,
    pub id: String,
    pub identity: String,
    pub legacy: String,
    /// Zabbix's values (no overlay): the new side of the review, and the fingerprint's input.
    pub values: Value,
    /// The same host as the cluster it is when in use (overlay laid over): what the review shows
    /// when another host conflicts with it.
    pub effective: Value,
}

/// What becomes of one host this build.
#[derive(Clone, Debug, PartialEq)]
pub enum Fate {
    /// Built as a cluster. `replaces`: the cluster it took over by an **update**; `decision`: the one
    /// that let it in, for a host that conflicted.
    Build { replaces: Option<Against>, decision: Option<Decision> },
    /// Held: pending, or skipped.
    Held,
    /// A Zabbix host another one took over by an **update**.
    Replaced { by: String },
}

pub struct Resolved {
    pub fate: HashMap<String, Fate>,
    /// The record as it should now be kept.
    pub entries: BTreeMap<String, Entry>,
    /// Whether that differs from what was kept.
    pub changed: bool,
    /// Host ids newly held and waiting (for the audit line).
    pub newly_held: Vec<String>,
    /// Every conflict in play this build, for the review: the entry, both sides, the state.
    pub review: Vec<Value>,
}

fn numeric_order(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        _ => a.cmp(b),
    }
}

/// Decide what each host found becomes, from the clusters that exist, what the last build used,
/// and what is kept. Pure: the caller keeps `entries` (unless it is a dry run or the worker).
/// `first_run`: no record was ever kept ([`BEFORE_REVIEW`]).
pub fn resolve(config: &[Known], hosts: &[Found], prev_used: &HashSet<String>, kept: &BTreeMap<String, Entry>,
               first_run: bool, now: u64) -> Resolved {
    let mut fate: HashMap<String, Fate> = HashMap::new();
    let mut entries = kept.clone();
    let mut newly_held = vec![];
    let mut review = vec![];
    let mut in_play: HashSet<String> = HashSet::new();
    let mut by_config: HashMap<&str, &Known> = HashMap::new();
    for k in config {
        by_config.entry(k.identity.as_str()).or_insert(k);
    }
    let mut groups: BTreeMap<&str, Vec<&Found>> = BTreeMap::new();
    for f in hosts {
        groups.entry(f.identity.as_str()).or_default().push(f);
    }
    for (identity, mut group) in groups {
        group.sort_by(|a, b| numeric_order(&a.host_id, &b.host_id));
        let (against, rivals): (Known, Vec<&Found>) = if let Some(k) = by_config.get(identity) {
            ((*k).clone(), group.clone())
        } else if group.len() == 1 {
            fate.insert(group[0].host_id.clone(), Fate::Build { replaces: None, decision: None });
            continue;
        } else {
            let named = group.iter().find(|f| group.iter().any(|g| g.host_id != f.host_id
                && kept.get(&g.host_id).is_some_and(|e| e.against.kind == "zabbix" && e.against.host_id == f.host_id)));
            let incumbent = named.or_else(|| group.iter().find(|f| prev_used.contains(&f.host_id))).copied().unwrap_or(group[0]);
            fate.insert(incumbent.host_id.clone(), Fate::Build { replaces: None, decision: None });
            let k = Known { kind: "zabbix", id: incumbent.id.clone(), host_id: incumbent.host_id.clone(), identity: identity.to_string(),
                            legacy: incumbent.legacy.clone(), values: incumbent.effective.clone() };
            (k, group.iter().filter(|f| f.host_id != incumbent.host_id).copied().collect())
        };
        let a = Against { kind: against.kind.to_string(), id: against.id.clone(), host_id: against.host_id.clone() };
        for f in rivals {
            in_play.insert(f.host_id.clone());
            let fp = fingerprint(&f.values);
            let mut e = match kept.get(&f.host_id).filter(|e| e.identity == identity && e.against == a) {
                Some(e) => e.clone(),
                None if first_run => {
                    let d = if a.kind == "config" && f.legacy == against.legacy { Decision::Update } else { Decision::KeepBoth };
                    Entry { decision: Some(d), decided_by: BEFORE_REVIEW.into(), decided_at: now, decided_fingerprint: fp.clone(),
                            decided_values: f.values.clone(), ..Default::default() }
                }
                None => {
                    newly_held.push(f.host_id.clone());
                    Entry::default()
                }
            };
            if e.first_seen == 0 {
                e.first_seen = now;
            }
            e.host = f.host.clone();
            e.identity = identity.to_string();
            e.against = a.clone();
            e.values = f.values.clone();
            e.fingerprint = fp.clone();
            if e.decision.is_some() && e.decided_fingerprint.is_empty() {
                e.decided_fingerprint = fp.clone();
                e.decided_values = f.values.clone();
            }
            let this = match e.decision {
                None | Some(Decision::Skip) => Fate::Held,
                Some(Decision::KeepBoth) => Fate::Build { replaces: None, decision: e.decision },
                Some(Decision::Update) => {
                    if a.kind == "zabbix" {
                        fate.insert(a.host_id.clone(), Fate::Replaced { by: f.id.clone() });
                    }
                    Fate::Build { replaces: Some(a.clone()), decision: e.decision }
                }
            };
            fate.insert(f.host_id.clone(), this);
            review.push(json!({
                "hostId": f.host_id, "host": f.host, "clusterId": f.id, "identity": identity,
                "state": e.state(), "decision": e.decision.map(Decision::as_str),
                "decidedBy": e.decided_by, "decidedAt": e.decided_at, "firstSeen": e.first_seen,
                "fingerprint": e.fingerprint,
                "existing": { "kind": a.kind, "id": a.id, "hostId": a.host_id, "values": against.values.clone() },
                "zabbix": f.values, "decidedValues": if e.decision.is_some() { e.decided_values.clone() } else { Value::Null },
            }));
            entries.insert(f.host_id.clone(), e);
        }
    }
    // A conflict no longer in play: an undecided entry is forgotten, a decided one kept.
    entries.retain(|k, e| in_play.contains(k) || e.decision.is_some());
    while entries.len() > MAX_ENTRIES {
        let oldest = entries.iter().filter(|(k, _)| !in_play.contains(*k)).min_by_key(|(_, e)| e.decided_at).map(|(k, _)| k.clone());
        match oldest {
            Some(k) => { entries.remove(&k); }
            None => break,
        }
    }
    review.sort_by(|a, b| {
        let rank = |v: &Value| match v["state"].as_str() { Some("pending") => 0, Some("changed") => 1, _ => 2 };
        rank(a).cmp(&rank(b)).then_with(|| a["host"].as_str().cmp(&b["host"].as_str()))
    });
    let changed = &entries != kept;
    Resolved { fate, entries, changed, newly_held, review }
}

/* ------------------------------------------ the store ------------------------------------------ */

#[derive(Serialize, Deserialize, Default)]
struct Kept {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

pub struct Conflicts {
    path: Option<PathBuf>,
    /// The entries, and whether a record was ever kept (a file, even an empty or unreadable one).
    state: RwLock<(BTreeMap<String, Entry>, bool)>,
}

impl Conflicts {
    pub fn open(path: Option<PathBuf>) -> Conflicts {
        let state = Self::read(path.as_ref());
        Conflicts { path, state: RwLock::new(state) }
    }

    fn read(path: Option<&PathBuf>) -> (BTreeMap<String, Entry>, bool) {
        let Some(p) = path else { return (BTreeMap::new(), true) };
        match std::fs::read_to_string(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (BTreeMap::new(), false),
            Err(e) => {
                tracing::warn!("{FILE} cannot be read, every conflict is held until it can: {e}");
                (BTreeMap::new(), true)
            }
            Ok(s) => match serde_json::from_str::<Kept>(&s) {
                Ok(k) => (k.entries, true),
                Err(e) => {
                    // Never a first run: that would record every conflict as decided.
                    tracing::warn!("{FILE} is unreadable, every conflict is held until it is fixed: {e}");
                    (BTreeMap::new(), true)
                }
            },
        }
    }

    /// Read the file again (the report worker, after the core changed it).
    pub fn reload(&self) {
        *self.state.write() = Self::read(self.path.as_ref());
    }

    pub fn all(&self) -> BTreeMap<String, Entry> {
        self.state.read().0.clone()
    }

    pub fn get(&self, host_id: &str) -> Option<Entry> {
        self.state.read().0.get(host_id).cloned()
    }

    /// No record was ever kept: the first build records what was in place ([`BEFORE_REVIEW`]).
    pub fn first_run(&self) -> bool {
        !self.state.read().1
    }

    fn save(&self, entries: &BTreeMap<String, Entry>) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let body = serde_json::to_vec_pretty(&json!({ "version": 1, "entries": entries })).map_err(|e| e.to_string())?;
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension(format!("json.{}.tmp", crate::auth::random_hex(6)));
        {
            use std::io::Write as _;
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            let mut f = o.open(&tmp).map_err(|e| format!("{FILE}.tmp: {e}"))?;
            f.write_all(&body).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{FILE}: {e}")
        })
    }

    /// Keep the record a build resolved. Written before it is believed: a failed write changes
    /// nothing, and the next build resolves again.
    pub fn commit(&self, entries: BTreeMap<String, Entry>) -> Result<(), String> {
        self.save(&entries)?;
        *self.state.write() = (entries, true);
        Ok(())
    }

    /// An administrator's decision on a held host, made on the values with this fingerprint.
    /// Refused when no conflict is kept for the host (`not_found`) or Zabbix's values moved since
    /// the review was opened (`changed_since_review`). Returns the entry as kept.
    pub fn decide(&self, host_id: &str, decision: Decision, seen: &str, by: &str, at: u64) -> Result<Entry, Refusal> {
        let mut next = self.state.read().0.clone();
        let Some(e) = next.get_mut(host_id) else {
            return Err(Refusal { kind: "not_found", message: format!("no Zabbix host {host_id:?} is held for review") });
        };
        if e.fingerprint != seen.trim() {
            return Err(Refusal { kind: "changed_since_review",
                                 message: "Zabbix's values for this host changed since the review was opened: open it again".into() });
        }
        e.decision = Some(decision);
        e.decided_by = by.to_string();
        e.decided_at = at;
        e.decided_fingerprint = e.fingerprint.clone();
        e.decided_values = e.values.clone();
        let kept = e.clone();
        self.commit(next).map_err(|m| Refusal { kind: "io_error", message: m })?;
        Ok(kept)
    }

    /// A host `createHosts` just made from a config-file cluster: decided **update** against that
    /// cluster before it is first seen, so it takes over as it always did — that is what the
    /// option asks for.
    pub fn preapprove(&self, host_id: &str, host: &str, identity: &str, config_id: &str, at: u64) -> Result<(), String> {
        let mut next = self.state.read().0.clone();
        next.insert(host_id.to_string(), Entry {
            host: host.to_string(), identity: identity.to_string(),
            against: Against { kind: "config".into(), id: config_id.to_string(), host_id: String::new() },
            first_seen: at, decision: Some(Decision::Update), decided_by: CREATE_HOSTS.into(), decided_at: at,
            ..Default::default()
        });
        self.commit(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(host_id: &str, host: &str, url: &str) -> Found {
        let values = json!({ "name": host, "url": url });
        Found { host_id: host_id.into(), host: host.into(), id: format!("zbx-{host}"), identity: url_key(url), legacy: legacy_key(url),
                values: values.clone(), effective: values }
    }
    fn config(id: &str, url: &str) -> Known {
        Known { kind: "config", id: id.into(), host_id: String::new(), identity: url_key(url), legacy: legacy_key(url),
                values: json!({ "name": id, "url": url }) }
    }

    #[test]
    fn identity_is_scheme_host_and_port() {
        for (a, b) in [
            ("https://es.example:9200", "https://ES.Example:9200/"),
            ("https://es.example", "https://es.example:443"),
            ("https://es.example:443/", "HTTPS://es.example"),
            ("http://es.example", "http://es.example:80/"),
            ("http://user:pw@es.example:9200", "http://es.example:9200"),
            ("http://es.example:9200?pretty", "http://es.example:9200/"),
            ("http://[FE80::1]:9200", "http://[fe80::1]:9200/"),
            ("http://es.example.:9200", "http://es.example:9200"),
            ("https://proxy.example/es1/", "https://PROXY.example:443/ES1"),
        ] {
            assert_eq!(url_identity(a), url_identity(b), "{a} = {b}");
            assert!(url_identity(a).is_some(), "{a}");
        }
        for (a, b) in [
            ("http://es.example:9200", "https://es.example:9200"),
            ("http://es.example:9200", "http://es.example:9201"),
            ("https://es.example", "https://es.example:9200"),
            ("http://es.example", "http://es.example:443"),
            ("https://proxy.example/es1", "https://proxy.example/es2"),
            ("http://a.example:9200", "http://b.example:9200"),
        ] {
            assert_ne!(url_key(a), url_key(b), "{a} != {b}");
        }
        assert_eq!(url_identity("https://ES.example").as_deref(), Some("https://es.example:443"));
        assert_eq!(url_identity("http://10.0.0.1:9200/").as_deref(), Some("http://10.0.0.1:9200"));
        assert_eq!(url_identity("http://[::1]").as_deref(), Some("http://[::1]:80"));
        for bad in ["es.example:9200", "ftp://es.example", "http://", "http://es.example:99999", "http://es:abc", "http://a b:9200"] {
            assert_eq!(url_identity(bad), None, "{bad}");
        }
        assert_eq!(url_key("es.example:9200/"), url_key("ES.example:9200"), "not an address: the text, without case or slash");
    }

    #[test]
    fn a_host_at_a_config_cluster_s_address_is_held_and_nothing_else_is() {
        let cfg = [config("lab", "https://lab.example:9200")];
        let hosts = [found("10", "lab-zbx", "https://LAB.example:9200/"), found("11", "other", "https://other.example:9200")];
        let r = resolve(&cfg, &hosts, &HashSet::new(), &BTreeMap::new(), false, 5);
        assert_eq!(r.fate["10"], Fate::Held);
        assert_eq!(r.fate["11"], Fate::Build { replaces: None, decision: None }, "the rest syncs as before");
        assert_eq!(r.newly_held, vec!["10"]);
        assert_eq!(r.review[0]["state"], json!("pending"));
        assert_eq!(r.review[0]["existing"]["id"], json!("lab"));
        assert!(r.changed);
    }

    #[test]
    fn the_first_build_records_what_the_pages_did_before() {
        let cfg = [config("a", "https://a.example:443/"), config("b", "https://b.example")];
        let hosts = [found("1", "a", "https://a.example:443"), found("2", "b", "https://b.example:443"),
                     found("3", "c1", "http://c:9200"), found("4", "c2", "http://C:9200/")];
        let r = resolve(&cfg, &hosts, &HashSet::new(), &BTreeMap::new(), true, 5);
        // The earlier rule set `a` aside (same text but the slash): update. `b` differs only by the
        // default port: both were in use, keep both. Two Zabbix hosts at one address: keep both.
        assert_eq!(r.entries["1"].decision, Some(Decision::Update));
        assert_eq!(r.entries["2"].decision, Some(Decision::KeepBoth));
        assert_eq!(r.entries["4"].decision, Some(Decision::KeepBoth));
        assert!(!r.entries.contains_key("3"), "the oldest host is the existing one");
        assert_eq!(r.entries["1"].decided_by, BEFORE_REVIEW);
        assert!(r.newly_held.is_empty());
        assert_eq!(r.fate["1"], Fate::Build { replaces: Some(Against { kind: "config".into(), id: "a".into(), host_id: String::new() }),
                                             decision: Some(Decision::Update) });
    }

    #[test]
    fn decisions_apply_and_ask_again_only_when_zabbix_s_values_change() {
        let cfg = [config("lab", "http://lab:9200")];
        let mut hosts = vec![found("10", "lab-zbx", "http://lab:9200")];
        let first = resolve(&cfg, &hosts, &HashSet::new(), &BTreeMap::new(), false, 5);
        let mut kept = first.entries.clone();
        for (d, want) in [(Decision::Skip, Fate::Held),
                          (Decision::KeepBoth, Fate::Build { replaces: None, decision: Some(Decision::KeepBoth) })] {
            let e = kept.get_mut("10").unwrap();
            e.decision = Some(d);
            e.decided_fingerprint = e.fingerprint.clone();
            let r = resolve(&cfg, &hosts, &HashSet::new(), &kept, false, 6);
            assert_eq!(r.fate["10"], want);
            assert_eq!(r.review[0]["state"], json!("decided"));
            assert!(!r.changed, "a repeat sync writes nothing");
        }
        // Zabbix renames the host: still applied, and asked again.
        hosts[0].values = json!({ "name": "renamed", "url": "http://lab:9200" });
        let r = resolve(&cfg, &hosts, &HashSet::new(), &kept, false, 7);
        assert_eq!(r.review[0]["state"], json!("changed"));
        assert_eq!(r.fate["10"], Fate::Build { replaces: None, decision: Some(Decision::KeepBoth) });
        // The conflict goes away (the config cluster was removed): a decided entry is kept, dormant.
        let gone = resolve(&[], &hosts, &HashSet::new(), &kept, false, 8);
        assert_eq!(gone.fate["10"], Fate::Build { replaces: None, decision: None });
        assert!(gone.entries.contains_key("10"));
        // An undecided one is forgotten.
        let gone = resolve(&[], &hosts, &HashSet::new(), &first.entries, false, 8);
        assert!(gone.entries.is_empty());
    }

    #[test]
    fn between_zabbix_hosts_the_one_in_use_stays_and_an_update_replaces_it() {
        // 20 was in use; 10 (older) gained the template later: 20 stays the existing one.
        let hosts = [found("10", "late", "http://x:9200"), found("20", "used", "http://x:9200")];
        let used: HashSet<String> = ["20".to_string()].into();
        let r = resolve(&[], &hosts, &used, &BTreeMap::new(), false, 5);
        assert_eq!(r.fate["20"], Fate::Build { replaces: None, decision: None });
        assert_eq!(r.fate["10"], Fate::Held);
        let mut kept = r.entries;
        let e = kept.get_mut("10").unwrap();
        e.decision = Some(Decision::Update);
        e.decided_fingerprint = e.fingerprint.clone();
        // After a restart nothing was in use yet; the kept entry still names the existing one.
        let r = resolve(&[], &hosts, &HashSet::new(), &kept, false, 6);
        assert_eq!(r.fate["20"], Fate::Replaced { by: "zbx-late".into() });
        assert!(matches!(r.fate["10"], Fate::Build { replaces: Some(_), .. }));
    }

    #[test]
    fn the_store_keeps_decisions_across_restarts_and_refuses_a_stale_review() {
        let p = std::env::temp_dir().join(format!("ep-conflicts-{}", crate::auth::random_hex(6))).join(FILE);
        let s = Conflicts::open(Some(p.clone()));
        assert!(s.first_run());
        let r = resolve(&[config("lab", "http://lab:9200")], &[found("10", "h", "http://lab:9200")], &HashSet::new(), &s.all(), false, 1);
        s.commit(r.entries).unwrap();
        assert!(!s.first_run());
        let fp = s.get("10").unwrap().fingerprint;
        assert_eq!(s.decide("10", Decision::Skip, "stale", "sara", 2).unwrap_err().kind, "changed_since_review");
        assert_eq!(s.decide("99", Decision::Skip, &fp, "sara", 2).unwrap_err().kind, "not_found");
        let e = s.decide("10", Decision::Skip, &fp, "sara", 2).unwrap();
        assert_eq!((e.decision, e.decided_by.as_str(), e.state()), (Some(Decision::Skip), "sara", "decided"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let again = Conflicts::open(Some(p.clone()));
        assert!(!again.first_run());
        assert_eq!(again.get("10").unwrap().decision, Some(Decision::Skip));
        // An unreadable file is never a first run.
        std::fs::write(&p, "{not json").unwrap();
        assert!(!Conflicts::open(Some(p.clone())).first_run());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }
}
