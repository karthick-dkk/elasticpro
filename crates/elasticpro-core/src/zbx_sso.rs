//! Signing in from Zabbix.
//!
//! The ElasticPro module inside Zabbix knows who is looking at the page — Zabbix has
//! already authenticated them — and needs this app to agree without asking for a second
//! password. It does that server to server:
//!
//! 1. Zabbix's PHP posts `{username, zabbix_user_type, groups, ts, nonce}` to
//!    `/sso/zabbix`, with an HMAC-SHA256 of the exact body under a secret both sides hold.
//! 2. This checks the signature, the clock and the nonce, creates or refreshes the account
//!    `<username>@zabbix`, and hands back a code that works once, for sixty seconds.
//! 3. The page Zabbix renders loads this app with that code; the app trades it for an
//!    ordinary session (`SSO_EXCHANGE`) and removes it from the address bar.
//!
//! What stops this being a way in for anybody else:
//!
//! * The secret. Without it no body verifies. It is read from the environment, never
//!   from the config the UI edits, and a short one disables the feature rather than
//!   weakening it.
//! * The route is meant for the internal network only. nginx refuses `/sso/` from
//!   outside; Zabbix reaches the core directly on the Docker network. Both are required
//!   — the network rule is not a substitute for the signature, nor the other way round.
//! * Replay. A signed body is good for sixty seconds and exactly once.
//! * The code, not a session, is what goes near a browser, and it is spent on first use.
//!
//! A second, read-only route asks who somebody is here, without signing them in:
//! `GET /sso/zabbix/role?claim=<JSON>` (see `RoleQuery`). The clients module in Zabbix
//! uses it to let an ElasticPro admin edit Cluster Management. The request is signed and
//! clock-checked exactly like the sign-in, carries a nonce that works once, and the answer
//! is signed back (`sign_reply`) over the request's `ts` and nonce, so the module can tell
//! an answer from this core from one somebody between the two made up.
//!
//! The mapping, which is the product decision this implements, as shipped (`RoleMap`;
//! an ElasticPro admin changes it on the Accounts page, `zabbix.roleMap` in the config):
//!
//! | Zabbix user type | Here      | Clusters                                   |
//! |------------------|-----------|--------------------------------------------|
//! | 1 User           | user      | only those tagged with one of their groups |
//! | 2 Admin          | operator  | all                                        |
//! | 3 Super admin    | admin     | all                                        |
//!
//! A newer embed module also names the Zabbix *role* ("Admin role", or one the site made);
//! a name the map knows wins over the type, so a site can hand one custom Zabbix role to
//! ElasticPro admins without making its holders Zabbix Super admins.
//!
//! Since the user-group map (`RoleMap::groups`, modules 2.1.20) the table above is only the
//! *fallback*: each ElasticPro role holds any number of Zabbix user groups, a person in several
//! gets the highest, and a person in none gets the table above — or nothing, when the admin
//! chose `unmapped: none`. A role an admin set by hand on the Accounts page (pinned, "No
//! access" included) wins over all of it; `auth::UserStore` holds those.

use crate::auth::{ct_eq, random_hex, Account, Role};
use hmac::{Hmac, Mac};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How far the Zabbix server's clock may be from ours, either way.
pub const MAX_SKEW_SECS: u64 = 60;
/// How long a code survives between Zabbix minting it and the browser spending it.
pub const CODE_TTL: Duration = Duration::from_secs(60);
/// Shorter than this and the secret is refused, which leaves the feature off.
pub const MIN_SECRET_LEN: usize = 32;
/// What every account made this way is called: `alice@zabbix`. Namespaced so a Zabbix
/// user named `admin` is never the local `admin`.
pub const SUFFIX: &str = "@zabbix";
pub const SOURCE: &str = "zabbix";

/// A Zabbix user group as a claim or the role map names it: always by name, and by id when the
/// embed module knows it (2.1.20 on). Group names are unique in Zabbix, so a name alone
/// identifies a group; the id survives a rename. Accepted from JSON as `"NOC"`,
/// `{"id": "7", "name": "NOC"}` or Zabbix's own `{"usrgrpid": "7", "name": "NOC"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
}

impl GroupRef {
    pub fn named(name: &str) -> GroupRef {
        GroupRef { id: None, name: name.trim().to_string() }
    }

    /// The longest group name Zabbix allows (usrgrp.name is 255), and the longest id taken.
    pub const MAX_NAME: usize = 255;
    pub const MAX_ID: usize = 20;

    /// Whether this map entry names that group of the claim: by id alone when both have one (a
    /// group deleted and recreated under the same name is another group), else by name, exactly
    /// (Zabbix compares group names case-sensitively, so a map entry must too — "NOC" and "noc"
    /// can both exist).
    pub fn matches(&self, other: &GroupRef) -> bool {
        match (&self.id, &other.id) {
            (Some(a), Some(b)) => a == b,
            _ => self.name.trim() == other.name.trim(),
        }
    }

    /// Why this reference cannot be used, if it cannot.
    pub fn check(&self) -> Result<(), String> {
        let n = self.name.trim();
        if n.is_empty() || n.len() > GroupRef::MAX_NAME || n.chars().any(char::is_control) {
            return Err(format!("a Zabbix user group name must be 1–{} characters with no control characters", GroupRef::MAX_NAME));
        }
        if let Some(id) = &self.id {
            if id.is_empty() || id.len() > GroupRef::MAX_ID || !id.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!("{n:?}: a Zabbix user group id is a number"));
            }
        }
        Ok(())
    }

    /// As the config file and the pages carry it: the name alone when there is no id.
    pub fn to_json(&self) -> serde_json::Value {
        match &self.id {
            Some(id) => serde_json::json!({ "id": id, "name": self.name }),
            None => serde_json::Value::String(self.name.clone()),
        }
    }

    pub fn from_value(v: &serde_json::Value) -> Option<GroupRef> {
        match v {
            serde_json::Value::String(s) => Some(GroupRef::named(s)),
            serde_json::Value::Object(m) => {
                let name = m.get("name")?.as_str()?.trim().to_string();
                let id = m.get("id").or_else(|| m.get("usrgrpid")).and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.trim().to_string()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                }).filter(|s| !s.is_empty());
                Some(GroupRef { id, name })
            }
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for GroupRef {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<GroupRef, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        GroupRef::from_value(&v).ok_or_else(|| serde::de::Error::custom("a user group is a name, or {id, name}"))
    }
}

/// What Zabbix vouches for.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Claim {
    pub username: String,
    pub zabbix_user_type: i64,
    /// The names of the user's Zabbix user groups: the sign-in scope, and — for a module
    /// older than 2.1.20, which sends no `user_groups` — the groups the role map matches.
    #[serde(default)]
    pub groups: Vec<String>,
    /// The Zabbix role's name ("Admin role", …). Sent by embed modules from 2.1.13; an
    /// older module sends none and the user type alone decides.
    #[serde(default)]
    pub zabbix_role: Option<String>,
    #[serde(default)]
    pub zabbix_roleid: Option<i64>,
    /// The user's Zabbix user groups with their ids (modules 2.1.20 on): what the role map
    /// (`RoleMap::groups`) decides on.
    #[serde(default)]
    pub user_groups: Vec<GroupRef>,
    pub ts: u64,
    pub nonce: String,
}

impl Claim {
    /// The groups the role map matches: `user_groups` when the module sent them, else the
    /// names in `groups`.
    pub fn group_refs(&self) -> Vec<GroupRef> {
        group_refs(&self.user_groups, &self.groups)
    }
}

/// `user_groups` when there are any, else the names: one definition for the claim and the
/// role lookup.
pub fn group_refs(with_ids: &[GroupRef], names: &[String]) -> Vec<GroupRef> {
    if !with_ids.is_empty() {
        return with_ids.to_vec();
    }
    names.iter().map(|n| GroupRef::named(n)).filter(|g| !g.name.is_empty()).collect()
}

/// Why a list of groups in a signed body is refused, if it is.
fn check_groups(names: &[String], with_ids: &[GroupRef]) -> Result<(), SsoError> {
    if names.len() > 500 || names.iter().any(|g| g.len() > GroupRef::MAX_NAME) {
        return Err(SsoError::BadBody("too many groups, or a group name over 255 characters".into()));
    }
    if with_ids.len() > 500 {
        return Err(SsoError::BadBody("too many user_groups".into()));
    }
    if let Some(why) = with_ids.iter().find_map(|g| g.check().err()) {
        return Err(SsoError::BadBody(format!("user_groups: {why}")));
    }
    Ok(())
}

/// "What is this Zabbix user's ElasticPro role?" — the signed body of a role lookup.
/// Nothing is created or changed by it; the nonce is there so the answer can be bound to
/// this one question (and the question asked once).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RoleQuery {
    pub zabbix_user: String,
    pub zabbix_user_type: i64,
    /// The Zabbix role's name, when the module knows to send it (2.1.13 on).
    #[serde(default)]
    pub zabbix_role: Option<String>,
    /// The user's Zabbix user groups (2.1.20 on), so the answer for a person never seen here
    /// can come from the group map, as their first sign-in would.
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub user_groups: Vec<GroupRef>,
    pub ts: u64,
    pub nonce: String,
}

impl RoleQuery {
    pub fn group_refs(&self) -> Vec<GroupRef> {
        group_refs(&self.user_groups, &self.groups)
    }
}

/// "Keep this Elasticsearch password for this cluster" — the signed body the Zabbix module
/// posts to `/sso/zabbix/cluster-secret` when an admin types a cluster's password (or the
/// default's, `cluster: "*"`) in Cluster Management. `cluster` is the cluster host's technical
/// name. Same secret, signature, clock window and once-only nonce as the role lookup.
#[derive(Clone, Deserialize, PartialEq)]
pub struct SecretPush {
    pub cluster: String,
    #[serde(default)]
    pub user: String,
    pub password: String,
    pub set_by: String,
    pub ts: u64,
    pub nonce: String,
}

impl std::fmt::Debug for SecretPush {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretPush").field("cluster", &self.cluster).field("user", &self.user)
            .field("password", &"<redacted>").field("set_by", &self.set_by).field("ts", &self.ts).finish()
    }
}

#[derive(Debug, PartialEq)]
pub enum SsoError {
    NotConfigured,
    BadSignature,
    BadBody(String),
    Stale,
    Replayed,
    /// The Zabbix role (named, or the user type) maps to no ElasticPro role here.
    NoRole(String),
}

impl std::fmt::Display for SsoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SsoError::NotConfigured => write!(f, "Zabbix sign-in is not configured: set ELASTICPRO_ZABBIX_SSO_SECRET (at least {MIN_SECRET_LEN} characters) on the core"),
            SsoError::BadSignature => write!(f, "the signature does not match — the module_secret in the Zabbix module and ELASTICPRO_ZABBIX_SSO_SECRET here differ"),
            SsoError::BadBody(why) => write!(f, "the sign-in request is malformed: {why}"),
            SsoError::Stale => write!(f, "the sign-in request is too old or from the future — check the clocks on the Zabbix and ElasticPro hosts"),
            SsoError::Replayed => write!(f, "that sign-in request was already used"),
            SsoError::NoRole(who) => write!(f, "{who} has no ElasticPro role here (the role map on ElasticPro's Accounts page decides; guests are never signed in)"),
        }
    }
}

/// The role a Zabbix user type becomes under the shipped map. Guest (4) and anything
/// unknown get nothing. `RoleMap::resolve` is the full answer once a site changed the map.
pub fn role_for(zabbix_user_type: i64) -> Option<Role> {
    RoleMap::default().resolve(None, zabbix_user_type)
}

/// Which ElasticPro role a Zabbix sign-in gets: `zabbix.roleMap` in the server's config.
///
/// Two tables. `names` is keyed by the Zabbix role's name (compared trimmed, case
/// folded) and wins when the module sent one and the map has it; `types` is keyed by
/// the Zabbix user type (1 User, 2 Admin, 3 Super admin) and is the fallback — and the
/// whole answer for an embed module older than 2.1.13, which sends no role name. A
/// value of `None` means "no access": that Zabbix role is not signed in at all.
///
/// In the file:
///
/// ```yaml
/// zabbix:
///   roleMap:
///     names: { "Admin role": operator, "ES owners": admin }
///     types: { "1": user, "2": operator, "3": admin }
/// ```
///
/// A value is `admin`, `operator`, `user`, `guest` or `none`.
///
/// The user-group map on top (Config → Zabbix, "ElasticPro roles from Zabbix user groups"):
///
/// ```yaml
/// zabbix:
///   roleMap:
///     groups:
///       admin: ["ElasticPro admins", { id: "7", name: "Zabbix administrators" }]
///       operator: ["NOC leads"]
///       user: ["NOC"]
///       guest: []
///     unmapped: zabbixRole      # or none: people in no listed group are not signed in
/// ```
///
/// A person in several listed groups gets the highest role. A person in none gets what
/// `names`/`types` say (`unmapped: zabbixRole`, the default — so a file without `groups`
/// behaves exactly as before) or nothing (`unmapped: none`).
#[derive(Debug, Clone, PartialEq)]
pub struct RoleMap {
    pub names: Vec<(String, Option<Role>)>,
    pub types: Vec<(i64, Option<Role>)>,
    /// Each ElasticPro role's Zabbix user groups, highest role first — always all four, so
    /// the file and the page show every row.
    pub groups: Vec<(Role, Vec<GroupRef>)>,
    /// What a person in none of the listed groups gets.
    pub unmapped: Unmapped,
}

/// The rule for a person in none of the mapped user groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unmapped {
    /// Today's rule: the Zabbix role's name (`names`), else the user type (`types`).
    ZabbixRole,
    /// No access: not signed in at all.
    None,
}

impl Unmapped {
    pub fn as_str(self) -> &'static str {
        match self {
            Unmapped::ZabbixRole => "zabbixRole",
            Unmapped::None => "none",
        }
    }

    pub fn parse(s: &str) -> Result<Unmapped, String> {
        match s.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
            "zabbixrole" | "zabbix" | "role" | "" => Ok(Unmapped::ZabbixRole),
            "none" | "noaccess" => Ok(Unmapped::None),
            _ => Err(format!("{s:?} is not an unmapped rule (zabbixRole or none)")),
        }
    }
}

/// Where a sign-in's role came from, for the log, the Zabbix users table and the refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A mapped user group gave it — this one (the highest, when several).
    Group(String),
    /// In no mapped group: the Zabbix role's name or user type decided (`unmapped: zabbixRole`).
    ZabbixRole,
    /// In no mapped group, and the map gives those people no access (`unmapped: none`).
    Unmapped,
}

impl Source {
    pub fn as_str(&self) -> &'static str {
        match self {
            Source::Group(_) => "group",
            Source::ZabbixRole => "zabbixRole",
            Source::Unmapped => "unmapped",
        }
    }
}

/// What the map says about one person: the role (`None`: not signed in), where it came from,
/// and every mapped group they are in with the role it gives, highest first — so a page can
/// say "Operator (highest of User, Operator)".
#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub role: Option<Role>,
    pub source: Source,
    pub matched: Vec<(String, Role)>,
}

impl Resolution {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "role": self.role.map(Role::as_str),
            "source": self.source.as_str(),
            "via": match &self.source { Source::Group(g) => Some(g.as_str()), _ => None },
            "matched": self.matched.iter().map(|(g, r)| serde_json::json!({ "group": g, "role": r.as_str() })).collect::<Vec<_>>(),
        })
    }
}

impl Default for RoleMap {
    fn default() -> RoleMap {
        RoleMap {
            names: vec![],
            types: vec![(1, Some(Role::User)), (2, Some(Role::Operator)), (3, Some(Role::Admin))],
            groups: RoleMap::ROLES.iter().map(|r| (*r, vec![])).collect(),
            unmapped: Unmapped::ZabbixRole,
        }
    }
}

impl RoleMap {
    /// The most entries a map may hold, and the longest Zabbix role name — bounds on what
    /// an admin can write into the config through `ZABBIX_ROLEMAP_SET`.
    pub const MAX_NAMES: usize = 64;
    pub const MAX_NAME_LEN: usize = 128;
    /// The most user groups the four rows may hold between them.
    pub const MAX_GROUPS: usize = 256;
    /// The Zabbix user types a `types` entry may name.
    pub const USER_TYPES: [i64; 3] = [1, 2, 3];
    /// The rows of the group table, highest first.
    pub const ROLES: [Role; 4] = [Role::Admin, Role::Operator, Role::User, Role::Guest];

    /// "admin" | "operator" | "user" | "guest" → that role; "none" (or "") → no access;
    /// anything else is a mistake.
    pub fn parse_target(s: &str) -> Result<Option<Role>, String> {
        let t = s.trim().to_ascii_lowercase();
        match t.as_str() {
            "" | "none" | "no access" => Ok(None),
            _ => Role::parse(&t).map(Some).ok_or_else(|| format!("{s:?} is not a role (admin, operator, user, guest or none)")),
        }
    }

    pub fn target_str(r: Option<Role>) -> &'static str {
        r.map(Role::as_str).unwrap_or("none")
    }

    /// The map `zabbix.roleMap` (or `role_map`) describes, over the shipped defaults: a
    /// type the file does not mention keeps its default. Anything malformed is skipped
    /// rather than failing the sign-in — a typo in the config must not lock everyone out;
    /// `ZABBIX_ROLEMAP_SET` refuses the same typo on the way in.
    pub fn from_config(zabbix: &serde_json::Value) -> RoleMap {
        let mut map = RoleMap::default();
        let Some(rm) = zabbix.get("roleMap").or_else(|| zabbix.get("role_map")).and_then(|v| v.as_object()) else { return map };
        if let Some(names) = rm.get("names").and_then(|v| v.as_object()) {
            for (k, v) in names.iter().take(RoleMap::MAX_NAMES) {
                let k = k.trim();
                if k.is_empty() || k.len() > RoleMap::MAX_NAME_LEN {
                    continue;
                }
                if let Ok(target) = v.as_str().map(RoleMap::parse_target).unwrap_or(Err(String::new())) {
                    map.names.retain(|(n, _)| !n.eq_ignore_ascii_case(k));
                    map.names.push((k.to_string(), target));
                }
            }
        }
        if let Some(types) = rm.get("types").and_then(|v| v.as_object()) {
            for (k, v) in types {
                let Ok(ty) = k.trim().parse::<i64>() else { continue };
                if !RoleMap::USER_TYPES.contains(&ty) {
                    continue;
                }
                if let Ok(target) = v.as_str().map(RoleMap::parse_target).unwrap_or(Err(String::new())) {
                    map.types.retain(|(t, _)| *t != ty);
                    map.types.push((ty, target));
                }
            }
        }
        map.types.sort_by_key(|(t, _)| *t);
        if let Some(groups) = rm.get("groups").and_then(|v| v.as_object()) {
            let mut n = 0;
            for (role, list) in groups {
                let Some(role) = Role::parse(role) else { continue };
                let Some(list) = list.as_array() else { continue };
                let row = map.groups.iter_mut().find(|(r, _)| *r == role).expect("every role has a row");
                row.1.clear();
                for g in list.iter().filter_map(GroupRef::from_value) {
                    if g.check().is_err() || n >= RoleMap::MAX_GROUPS {
                        continue;
                    }
                    n += 1;
                    row.1.push(g);
                }
            }
        }
        if let Some(u) = rm.get("unmapped").and_then(|v| v.as_str()) {
            // A typo here keeps today's rule rather than locking everybody out.
            map.unmapped = Unmapped::parse(u).unwrap_or(Unmapped::ZabbixRole);
        }
        map
    }

    /// The map as it is written to the config and shown on the Config page.
    pub fn to_json(&self) -> serde_json::Value {
        let names: serde_json::Map<String, serde_json::Value> =
            self.names.iter().map(|(n, r)| (n.clone(), serde_json::Value::String(RoleMap::target_str(*r).into()))).collect();
        let types: serde_json::Map<String, serde_json::Value> =
            self.types.iter().map(|(t, r)| (t.to_string(), serde_json::Value::String(RoleMap::target_str(*r).into()))).collect();
        let groups: serde_json::Map<String, serde_json::Value> = self.groups.iter()
            .map(|(r, gs)| (r.as_str().to_string(), serde_json::Value::Array(gs.iter().map(GroupRef::to_json).collect()))).collect();
        serde_json::json!({ "names": names, "types": types, "groups": groups, "unmapped": self.unmapped.as_str() })
    }

    /// Whether an admin has set up the group map: any group listed, or the unmapped rule
    /// changed. Until then the sign-in is exactly the name/type map's — the migration is that
    /// nothing changes until somebody saves the new table.
    pub fn group_map_saved(&self) -> bool {
        self.groups.iter().any(|(_, g)| !g.is_empty()) || self.unmapped == Unmapped::None
    }

    /// The groups the four rows list, flat: `(role, group)`.
    pub fn listed_groups(&self) -> impl Iterator<Item = (Role, &GroupRef)> {
        self.groups.iter().flat_map(|(r, gs)| gs.iter().map(move |g| (*r, g)))
    }

    /// The role the map gives one user group, if it lists it.
    pub fn role_of_group(&self, g: &GroupRef) -> Option<Role> {
        self.listed_groups().filter(|(_, m)| m.matches(g)).map(|(r, _)| r).max()
    }

    /// Check a map an admin sent (`ZABBIX_ROLEMAP_SET`, `ZABBIX_ROLEMAP_PREVIEW`), strictly:
    /// every key and value must be right, or the whole thing is refused with the first reason.
    /// A partial update over `base`, the map as it is now: a section the message leaves out
    /// (`names`, `types`, `groups`, `unmapped`) stays as it is; one it names is replaced whole.
    /// So a page that draws only the group table never drops a site's older role-name map.
    pub fn from_message(v: &serde_json::Value, base: &RoleMap) -> Result<RoleMap, String> {
        let Some(m) = v.as_object() else { return Err("roleMap must be an object with groups, unmapped, names and types".into()) };
        let mut map = base.clone();
        if let Some(names) = m.get("names") {
            let Some(names) = names.as_object() else { return Err("names must be an object: Zabbix role name → ElasticPro role".into()) };
            if names.len() > RoleMap::MAX_NAMES {
                return Err(format!("at most {} Zabbix role names", RoleMap::MAX_NAMES));
            }
            map.names.clear();
            for (k, v) in names {
                let k = k.trim();
                if k.is_empty() || k.len() > RoleMap::MAX_NAME_LEN || k.chars().any(char::is_control) {
                    return Err(format!("a Zabbix role name must be 1–{} characters with no control characters", RoleMap::MAX_NAME_LEN));
                }
                if map.names.iter().any(|(n, _)| n.eq_ignore_ascii_case(k)) {
                    return Err(format!("{k:?} is listed twice"));
                }
                let target = RoleMap::parse_target(v.as_str().ok_or_else(|| format!("{k}: the role must be a string"))?)?;
                map.names.push((k.to_string(), target));
            }
        }
        if let Some(types) = m.get("types") {
            let Some(given) = types.as_object() else { return Err("types must be an object: Zabbix user type → ElasticPro role".into()) };
            if let Some(extra) = given.keys().find(|k| !k.trim().parse::<i64>().is_ok_and(|n| RoleMap::USER_TYPES.contains(&n))) {
                return Err(format!("types.{extra}: Zabbix user types are 1 (User), 2 (Admin) and 3 (Super admin)"));
            }
            let mut out = vec![];
            for ty in RoleMap::USER_TYPES {
                let target = match given.get(&ty.to_string()) {
                    Some(v) => RoleMap::parse_target(v.as_str().ok_or_else(|| format!("types.{ty}: the role must be a string"))?)?,
                    None => base.types.iter().find(|(t, _)| *t == ty).and_then(|(_, r)| *r),
                };
                out.push((ty, target));
            }
            map.types = out;
        }
        if let Some(groups) = m.get("groups") {
            let Some(given) = groups.as_object() else { return Err("groups must be an object: ElasticPro role → list of Zabbix user groups".into()) };
            if let Some(bad) = given.keys().find(|k| Role::parse(k).is_none()) {
                return Err(format!("groups.{bad}: the rows are admin, operator, user and guest (no access is the unmapped rule, not a row)"));
            }
            let mut rows: Vec<(Role, Vec<GroupRef>)> = RoleMap::ROLES.iter().map(|r| (*r, vec![])).collect();
            let mut seen: Vec<GroupRef> = vec![];
            for (k, list) in given {
                let role = Role::parse(k).expect("checked above");
                let Some(list) = list.as_array() else { return Err(format!("groups.{k} must be a list of Zabbix user groups")) };
                for v in list {
                    let g = GroupRef::from_value(v).ok_or_else(|| format!("groups.{k}: a user group is a name, or {{id, name}}"))?;
                    g.check()?;
                    if seen.iter().any(|s| s.matches(&g)) {
                        return Err(format!("the user group {:?} is listed twice — a group belongs to one role; a person in several groups gets the highest", g.name.trim()));
                    }
                    seen.push(g.clone());
                    if seen.len() > RoleMap::MAX_GROUPS {
                        return Err(format!("at most {} Zabbix user groups in the map", RoleMap::MAX_GROUPS));
                    }
                    rows.iter_mut().find(|(r, _)| *r == role).expect("four rows").1.push(g);
                }
            }
            map.groups = rows;
        }
        if let Some(u) = m.get("unmapped") {
            map.unmapped = Unmapped::parse(u.as_str().ok_or("unmapped must be \"zabbixRole\" or \"none\"")?)?;
        }
        Ok(map)
    }

    /// The ElasticPro role for a sign-in by the Zabbix role alone: the role's name when the
    /// module sent one and the map knows it, else the user type. `None`: not signed in. The
    /// fallback half of `resolve_claim`, and the whole answer before the group map existed.
    pub fn resolve(&self, zabbix_role: Option<&str>, zabbix_user_type: i64) -> Option<Role> {
        if let Some(name) = zabbix_role.map(str::trim).filter(|n| !n.is_empty()) {
            if let Some((_, r)) = self.names.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
                return *r;
            }
        }
        self.types.iter().find(|(t, _)| *t == zabbix_user_type).and_then(|(_, r)| *r)
    }

    /// The whole answer for one person: the highest role of the mapped user groups they are
    /// in; in none, the unmapped rule — the Zabbix role (`resolve`) or no access. The one
    /// definition the sign-in, the role lookup, the Zabbix users table and the preview use.
    pub fn resolve_claim(&self, zabbix_role: Option<&str>, zabbix_user_type: i64, groups: &[GroupRef]) -> Resolution {
        let mut matched: Vec<(String, Role)> = vec![];
        for g in groups {
            if let Some(r) = self.role_of_group(g) {
                let name = g.name.trim().to_string();
                if !matched.iter().any(|(n, _)| *n == name) {
                    matched.push((name, r));
                }
            }
        }
        matched.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        if let Some((name, role)) = matched.first() {
            return Resolution { role: Some(*role), source: Source::Group(name.clone()), matched };
        }
        match self.unmapped {
            Unmapped::ZabbixRole => Resolution { role: self.resolve(zabbix_role, zabbix_user_type), source: Source::ZabbixRole, matched },
            Unmapped::None => Resolution { role: None, source: Source::Unmapped, matched },
        }
    }

    /// How a refused sign-in names what had no role, for the log and the 403.
    pub fn describe(zabbix_role: Option<&str>, zabbix_user_type: i64) -> String {
        match zabbix_role.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => format!("Zabbix role {n:?} (user type {zabbix_user_type})"),
            None => format!("Zabbix user type {zabbix_user_type}"),
        }
    }

    /// The refusal for a claim `resolve_claim` gave no role, naming the rule that refused.
    pub fn describe_refusal(zabbix_role: Option<&str>, zabbix_user_type: i64, groups: &[GroupRef], res: &Resolution) -> String {
        match res.source {
            Source::Unmapped => {
                let listed: Vec<String> = groups.iter().map(|g| format!("{:?}", g.name.trim())).collect();
                format!("a user in none of the Zabbix user groups the role map lists (in: {}), and the map gives those users no access",
                        if listed.is_empty() { "no groups".to_string() } else { listed.join(", ") })
            }
            _ => RoleMap::describe(zabbix_role, zabbix_user_type),
        }
    }

    /// How many accounts could still sign in as an administrator if this were the map: local
    /// admins; Zabbix accounts an admin pinned as admin; and Zabbix accounts whose last signed
    /// claim this map makes admin. Blocked, locked and no-access accounts count for nothing,
    /// and so does a Zabbix account whose groups were never recorded (an older module, or a
    /// sign-in before 0.3.55): what it would become is not known, so it is not counted.
    /// `ZABBIX_ROLEMAP_SET` refuses a map that leaves this at zero.
    pub fn admins_able(&self, accounts: &[Account]) -> usize {
        accounts.iter().filter(|a| a.active() && a.administers_under(self)).count()
    }
}

/// Which clusters a Zabbix sign-in may see: every one (`None`) unless the config asks for
/// Zabbix Users to be limited to their user groups (`zabbix.scopeUsersByGroup`). Admins and
/// super admins see the fleet either way.
pub fn scope_for(role: Role, groups: &[String], by_group: bool) -> Option<Vec<String>> {
    if by_group && role == Role::User {
        let mut g: Vec<String> = groups.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        g.sort();
        g.dedup();
        Some(g)
    } else {
        None
    }
}

/// What a role lookup's answer is signed over. Public so the module's test and this
/// crate's agree on one definition.
pub fn reply_material(ts: u64, nonce: &str, body: &[u8]) -> Vec<u8> {
    let mut m = format!("{ts}\n{nonce}\n").into_bytes();
    m.extend_from_slice(body);
    m
}

pub fn account_name(username: &str) -> String {
    format!("{}{SUFFIX}", username.trim())
}

pub struct ZabbixSso {
    secret: RwLock<Option<Vec<u8>>>,
    nonces: Mutex<HashMap<String, Instant>>,
    codes: Mutex<HashMap<String, (String, Instant)>>,
    code_ttl: Duration,
}

impl Default for ZabbixSso {
    fn default() -> Self {
        ZabbixSso {
            secret: RwLock::new(None),
            nonces: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
            code_ttl: CODE_TTL,
        }
    }
}

impl ZabbixSso {
    /// `ELASTICPRO_ZABBIX_SSO_SECRET`, or the contents of `ELASTICPRO_ZABBIX_SSO_SECRET_FILE`.
    pub fn from_env() -> ZabbixSso {
        let s = ZabbixSso::default();
        let secret = std::env::var("ELASTICPRO_ZABBIX_SSO_SECRET").ok().filter(|v| !v.trim().is_empty()).or_else(|| {
            std::env::var("ELASTICPRO_ZABBIX_SSO_SECRET_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok())
        });
        if let Some(sec) = secret {
            if let Err(why) = s.set_secret(&sec) {
                tracing::warn!("Zabbix sign-in left off: {why}");
            }
        }
        s
    }

    pub fn set_secret(&self, secret: &str) -> Result<(), String> {
        let t = secret.trim();
        if t.len() < MIN_SECRET_LEN {
            return Err(format!("the secret is {} characters; at least {MIN_SECRET_LEN} are required", t.len()));
        }
        *self.secret.write() = Some(t.as_bytes().to_vec());
        Ok(())
    }

    pub fn configured(&self) -> bool {
        self.secret.read().is_some()
    }

    /// Turn sign-in off: nothing verifies until a secret is set again. Unpairing uses it.
    pub fn clear_secret(&self) {
        *self.secret.write() = None;
    }

    #[doc(hidden)]
    pub fn with_code_ttl(mut self, ttl: Duration) -> Self {
        self.code_ttl = ttl;
        self
    }

    /// Hex HMAC-SHA256 of `body` under the secret. Public so the tests — and the Zabbix
    /// module's own test — sign exactly the way this verifies.
    pub fn sign(secret: &[u8], body: &[u8]) -> String {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("hmac takes any key length");
        m.update(body);
        hex::encode(m.finalize().into_bytes())
    }

    /// Whether `signature_hex` is the HMAC of exactly these bytes under `secret`, compared
    /// in constant time. The one check every signed request from the Zabbix module goes
    /// through — the sign-in here, and the pairing in `zbx_link` — so there is one
    /// implementation of the scheme, not two that could drift.
    pub fn signature_ok(secret: &[u8], body: &[u8], signature_hex: &str) -> bool {
        let want = ZabbixSso::sign(secret, body);
        let got = signature_hex.trim().to_ascii_lowercase();
        ct_eq(want.as_bytes(), got.as_bytes())
    }

    /// The clock and the replay check, shared by the sign-in and the role lookup: a signed
    /// body is good within `MAX_SKEW_SECS` of now and once.
    fn fresh_once(&self, ts: u64, nonce: &str, now_secs: u64) -> Result<(), SsoError> {
        if nonce.len() < 16 || nonce.len() > 128 {
            return Err(SsoError::BadBody("nonce must be 16–128 characters".into()));
        }
        if now_secs.abs_diff(ts) > MAX_SKEW_SECS {
            return Err(SsoError::Stale);
        }
        let mut seen = self.nonces.lock();
        // Anything older than twice the skew can no longer pass the clock check, so it
        // no longer needs remembering.
        let keep = Duration::from_secs(MAX_SKEW_SECS * 2 + 5);
        seen.retain(|_, t| t.elapsed() < keep);
        if seen.contains_key(nonce) {
            return Err(SsoError::Replayed);
        }
        seen.insert(nonce.to_string(), Instant::now());
        Ok(())
    }

    /// Check a signed role lookup and return what it asks. Same secret, same signature over
    /// the exact bytes, same clock window and the same once-only nonce as the sign-in. A
    /// Zabbix user type with no role here is not refused: the question is read-only, and
    /// the answer for such a type is simply "no role from Zabbix".
    pub fn verify_role_query(&self, body: &[u8], signature_hex: &str, now_secs: u64) -> Result<RoleQuery, SsoError> {
        let secret = self.secret.read().clone().ok_or(SsoError::NotConfigured)?;
        if !ZabbixSso::signature_ok(&secret, body, signature_hex) {
            return Err(SsoError::BadSignature);
        }
        let q: RoleQuery = serde_json::from_slice(body).map_err(|e| SsoError::BadBody(e.to_string()))?;
        let name = q.zabbix_user.trim();
        if name.is_empty() || name.len() > 128 || name.chars().any(|ch| ch.is_control()) {
            return Err(SsoError::BadBody("zabbix_user is empty, too long or has control characters".into()));
        }
        check_groups(&q.groups, &q.user_groups)?;
        self.fresh_once(q.ts, &q.nonce, now_secs)?;
        Ok(q)
    }

    /// Check a signed password hand-over and return it. The password is never part of an error.
    pub fn verify_secret_push(&self, body: &[u8], signature_hex: &str, now_secs: u64) -> Result<SecretPush, SsoError> {
        let secret = self.secret.read().clone().ok_or(SsoError::NotConfigured)?;
        if !ZabbixSso::signature_ok(&secret, body, signature_hex) {
            return Err(SsoError::BadSignature);
        }
        // Parse errors from serde can quote the input; the reason given is ours alone.
        let q: SecretPush = serde_json::from_slice(body).map_err(|_| SsoError::BadBody("not {cluster, user, password, set_by, ts, nonce}".into()))?;
        let bad = |v: &str, max: usize| v.trim().is_empty() || v.len() > max || v.chars().any(char::is_control) || v.trim() != v;
        if bad(&q.cluster, 128) {
            return Err(SsoError::BadBody("cluster is empty, too long or has control characters".into()));
        }
        if bad(&q.set_by, 128) {
            return Err(SsoError::BadBody("set_by is empty, too long or has control characters".into()));
        }
        if q.user.len() > 128 || q.user.chars().any(char::is_control) {
            return Err(SsoError::BadBody("user is too long or has control characters".into()));
        }
        if q.password.is_empty() || q.password.len() > crate::cluster_secrets::MAX_PASSWORD {
            return Err(SsoError::BadBody(format!("the password must be 1–{} bytes", crate::cluster_secrets::MAX_PASSWORD)));
        }
        self.fresh_once(q.ts, &q.nonce, now_secs)?;
        Ok(q)
    }

    /// The signature on a role lookup's answer: HMAC-SHA256 under the shared secret of
    /// `"<ts>\n<nonce>\n<exact body bytes>"`, with the ts and nonce of the request it
    /// answers. `None` when no secret is set (then nothing was verified either).
    pub fn sign_reply(&self, ts: u64, nonce: &str, body: &[u8]) -> Option<String> {
        let secret = self.secret.read().clone()?;
        Some(ZabbixSso::sign(&secret, &reply_material(ts, nonce, body)))
    }

    /// Check a signed body and return what it claims. `now_secs` is a parameter so the
    /// clock can be tested; the caller passes the real one.
    pub fn verify(&self, body: &[u8], signature_hex: &str, now_secs: u64) -> Result<Claim, SsoError> {
        let secret = self.secret.read().clone().ok_or(SsoError::NotConfigured)?;
        // Signature before anything else is read: an unsigned body is not parsed at all.
        if !ZabbixSso::signature_ok(&secret, body, signature_hex) {
            return Err(SsoError::BadSignature);
        }
        let c: Claim = serde_json::from_slice(body).map_err(|e| SsoError::BadBody(e.to_string()))?;
        let name = c.username.trim();
        if name.is_empty() || name.len() > 128 || name.chars().any(|ch| ch.is_control()) {
            return Err(SsoError::BadBody("username is empty, too long or has control characters".into()));
        }
        if c.nonce.len() < 16 || c.nonce.len() > 128 {
            return Err(SsoError::BadBody("nonce must be 16–128 characters".into()));
        }
        check_groups(&c.groups, &c.user_groups)?;
        if c.zabbix_role.as_deref().is_some_and(|r| r.len() > RoleMap::MAX_NAME_LEN || r.chars().any(char::is_control)) {
            return Err(SsoError::BadBody("zabbix_role is too long or has control characters".into()));
        }
        self.fresh_once(c.ts, &c.nonce, now_secs)?;
        // Whether this role gets in is the map's call (`RoleMap::resolve`), made by the
        // caller with the server's config in hand; verifying is about who sent this.
        Ok(c)
    }

    /// Housekeeping: forget replay nonces and sign-in codes whose time has passed (they are
    /// otherwise forgotten only when the next one arrives). Returns how many; with
    /// `dry_run` it only counts.
    pub fn sweep_expired(&self, dry_run: bool) -> usize {
        let keep = Duration::from_secs(MAX_SKEW_SECS * 2 + 5);
        let ttl = self.code_ttl;
        let (mut nonces, mut codes) = (self.nonces.lock(), self.codes.lock());
        let n = nonces.values().filter(|t| t.elapsed() >= keep).count()
            + codes.values().filter(|(_, t)| t.elapsed() >= ttl).count();
        if !dry_run {
            nonces.retain(|_, t| t.elapsed() < keep);
            codes.retain(|_, (_, t)| t.elapsed() < ttl);
        }
        n
    }

    /// A one-time code for this account.
    pub fn issue_code(&self, account: &str) -> String {
        let code = random_hex(32);
        let mut codes = self.codes.lock();
        let ttl = self.code_ttl;
        codes.retain(|_, (_, t)| t.elapsed() < ttl);
        codes.insert(code.clone(), (account.to_string(), Instant::now()));
        code
    }

    /// The account a code was issued for — once. Spent whether or not it had expired.
    pub fn redeem(&self, code: &str) -> Option<String> {
        let (account, at) = self.codes.lock().remove(code.trim())?;
        (at.elapsed() < self.code_ttl).then_some(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-test";

    fn sso() -> ZabbixSso {
        let s = ZabbixSso::default();
        s.set_secret(SECRET).unwrap();
        s
    }

    fn body(user: &str, ty: i64, groups: &[&str], ts: u64, nonce: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "username": user, "zabbix_user_type": ty, "groups": groups, "ts": ts, "nonce": nonce,
        }))
        .unwrap()
    }

    fn signed(b: &[u8]) -> String {
        ZabbixSso::sign(SECRET.as_bytes(), b)
    }

    const NOW: u64 = 1_790_000_000;

    fn push(cluster: &str, password: &str, ts: u64, nonce: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "cluster": cluster, "user": "elastic", "password": password, "set_by": "alice", "ts": ts, "nonce": nonce })).unwrap()
    }

    #[test]
    fn a_signed_password_hand_over_is_accepted_once_and_never_shown() {
        let s = sso();
        let b = push("prod-es", "hunter2", 1000, "n-0123456789abcdef");
        let q = s.verify_secret_push(&b, &signed(&b), 1000).unwrap();
        assert_eq!((q.cluster.as_str(), q.password.as_str()), ("prod-es", "hunter2"));
        assert!(!format!("{q:?}").contains("hunter2"));
        assert_eq!(s.verify_secret_push(&b, &signed(&b), 1000), Err(SsoError::Replayed));
        let d = push("*", "def", 1000, "n-default-0123456789");
        assert_eq!(s.verify_secret_push(&d, &signed(&d), 1000).unwrap().cluster, "*", "the default is cluster \"*\"");
    }

    #[test]
    fn a_hand_over_unsigned_stale_or_malformed_is_refused_without_the_password_in_the_reason() {
        let s = sso();
        let b = push("prod-es", "hunter2", 1000, "n-0123456789abcdef");
        assert_eq!(s.verify_secret_push(&b, "00", 1000), Err(SsoError::BadSignature));
        assert_eq!(s.verify_secret_push(&b, &signed(&b), 5000), Err(SsoError::Stale));
        let e = push("", "hunter2", 1000, "n-aaaaaaaaaaaaaaaa");
        assert!(matches!(s.verify_secret_push(&e, &signed(&e), 1000), Err(SsoError::BadBody(_))));
        let e = push("prod-es", "", 1000, "n-bbbbbbbbbbbbbbbb");
        assert!(matches!(s.verify_secret_push(&e, &signed(&e), 1000), Err(SsoError::BadBody(_))));
        let junk = br#"{"cluster":"x","password":"hunter2"}"#.to_vec();
        match s.verify_secret_push(&junk, &signed(&junk), 1000) {
            Err(SsoError::BadBody(why)) => assert!(!why.contains("hunter2")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_correctly_signed_request_is_accepted() {
        let b = body("alice", 1, &["ES vm-1"], NOW, "nonce-0000000001");
        let c = sso().verify(&b, &signed(&b), NOW).unwrap();
        assert_eq!(c.username, "alice");
        assert_eq!(c.groups, vec!["ES vm-1".to_string()]);
    }

    #[test]
    fn the_signature_is_over_the_exact_bytes() {
        // Re-serialising would change nothing semantically and everything cryptographically:
        // the MAC covers what was sent, so one changed byte is a different request.
        let b = body("alice", 1, &[], NOW, "nonce-0000000002");
        let sig = signed(&b);
        let tampered = body("alice", 3, &[], NOW, "nonce-0000000002");
        assert_eq!(sso().verify(&tampered, &sig, NOW), Err(SsoError::BadSignature));
    }

    #[test]
    fn a_different_secret_is_refused() {
        let b = body("alice", 1, &[], NOW, "nonce-0000000003");
        let wrong = ZabbixSso::sign(b"another-secret-that-is-long-enough-000", &b);
        assert_eq!(sso().verify(&b, &wrong, NOW), Err(SsoError::BadSignature));
    }

    #[test]
    fn an_unconfigured_core_refuses_everything() {
        let b = body("alice", 3, &[], NOW, "nonce-0000000004");
        assert_eq!(ZabbixSso::default().verify(&b, &signed(&b), NOW), Err(SsoError::NotConfigured));
    }

    #[test]
    fn a_short_secret_leaves_the_feature_off() {
        let s = ZabbixSso::default();
        assert!(s.set_secret("short").is_err());
        assert!(!s.configured());
    }

    #[test]
    fn old_and_future_requests_are_refused() {
        let s = sso();
        let old = body("a", 1, &[], NOW - MAX_SKEW_SECS - 1, "nonce-0000000005");
        assert_eq!(s.verify(&old, &signed(&old), NOW), Err(SsoError::Stale));
        let fut = body("a", 1, &[], NOW + MAX_SKEW_SECS + 1, "nonce-0000000006");
        assert_eq!(s.verify(&fut, &signed(&fut), NOW), Err(SsoError::Stale));
        let edge = body("a", 1, &[], NOW - MAX_SKEW_SECS, "nonce-0000000007");
        assert!(s.verify(&edge, &signed(&edge), NOW).is_ok(), "the boundary itself is inside the window");
    }

    #[test]
    fn a_request_works_once() {
        let s = sso();
        let b = body("alice", 1, &[], NOW, "nonce-0000000008");
        let sig = signed(&b);
        assert!(s.verify(&b, &sig, NOW).is_ok());
        assert_eq!(s.verify(&b, &sig, NOW), Err(SsoError::Replayed));
    }

    #[test]
    fn a_guest_verifies_but_the_map_gives_it_no_role() {
        let s = sso();
        let b = body("guest", 4, &[], NOW, "nonce-0000000009");
        let c = s.verify(&b, &signed(&b), NOW).expect("the signature is what verify checks");
        assert_eq!(RoleMap::default().resolve(c.zabbix_role.as_deref(), c.zabbix_user_type), None);
        assert_eq!(c.zabbix_role, None, "an older module sends no role name");
    }

    #[test]
    fn the_role_map_prefers_a_named_role_and_falls_back_to_the_type() {
        let m = RoleMap::from_config(&serde_json::json!({ "roleMap": {
            "names": { "ES owners": "admin", " Admin role ": "user", "Nobody": "none" },
            "types": { "2": "admin", "9": "admin", "1": "guest" } } }));
        assert_eq!(m.resolve(Some("es owners"), 1), Some(Role::Admin), "names fold case; the name wins over the type");
        assert_eq!(m.resolve(Some("Admin role"), 2), Some(Role::User));
        assert_eq!(m.resolve(Some("Nobody"), 3), None, "a name mapped to none refuses even a Super admin");
        assert_eq!(m.resolve(Some("Unknown role"), 2), Some(Role::Admin), "an unknown name: the type decides, as the file set it");
        assert_eq!(m.resolve(None, 2), Some(Role::Admin));
        assert_eq!(m.resolve(None, 1), Some(Role::Guest), "guest is a role here: the dashboard only");
        assert_eq!(m.resolve(None, 3), Some(Role::Admin), "a type the file does not mention keeps its default");
        assert_eq!(m.resolve(None, 9), None);
        // What it round-trips to.
        let j = m.to_json();
        assert_eq!(j["names"]["ES owners"], serde_json::json!("admin"));
        assert_eq!(j["names"]["Admin role"], serde_json::json!("user"), "trimmed on the way in");
        assert_eq!(j["names"]["Nobody"], serde_json::json!("none"));
        assert_eq!(j["types"], serde_json::json!({ "1": "guest", "2": "admin", "3": "admin" }));
        assert_eq!(RoleMap::from_config(&serde_json::json!({})), RoleMap::default());
        assert_eq!(RoleMap::from_config(&serde_json::json!({ "roleMap": { "types": { "2": "emperor" } } })), RoleMap::default(),
                   "a value that is not a role is skipped, never a lock-out");
    }

    #[test]
    fn a_map_from_an_admin_is_checked_strictly() {
        let base = RoleMap::default();
        let ok = RoleMap::from_message(&serde_json::json!({ "names": { "ES owners": "admin" }, "types": { "2": "admin" } }), &base).unwrap();
        assert_eq!(ok.resolve(None, 2), Some(Role::Admin));
        assert_eq!(ok.resolve(None, 1), Some(Role::User), "types left out keep their defaults");
        assert_eq!(ok.types.len(), 3);
        for (bad, why) in [
            (serde_json::json!("x"), "not an object"),
            (serde_json::json!({ "names": { "": "admin" } }), "empty name"),
            (serde_json::json!({ "names": { "A": "emperor" } }), "not a role"),
            (serde_json::json!({ "names": { "A": "admin", "a": "user" } }), "the same name twice"),
            (serde_json::json!({ "types": { "4": "user" } }), "guest type"),
            (serde_json::json!({ "types": { "2": 3 } }), "a number for a role"),
            (serde_json::json!({ "groups": { "none": ["NOC"] } }), "no access is not a row"),
            (serde_json::json!({ "groups": { "admin": ["NOC"], "user": ["NOC"] } }), "a group in two rows"),
            (serde_json::json!({ "groups": { "admin": [{ "id": "7", "name": "A" }], "user": [{ "id": "7", "name": "B" }] } }), "one id in two rows"),
            (serde_json::json!({ "groups": { "admin": [""] } }), "an empty group name"),
            (serde_json::json!({ "groups": { "admin": [{ "id": "x7", "name": "A" }] } }), "an id that is not a number"),
            (serde_json::json!({ "groups": { "admin": "NOC" } }), "a row that is not a list"),
            (serde_json::json!({ "unmapped": "emperor" }), "an unmapped rule that is neither"),
            (serde_json::json!({ "unmapped": 1 }), "an unmapped rule that is not a string"),
        ] {
            assert!(RoleMap::from_message(&bad, &base).is_err(), "{why}");
        }
        assert_eq!(RoleMap::parse_target("none"), Ok(None));
        assert_eq!(RoleMap::parse_target(" Operator "), Ok(Some(Role::Operator)));
    }

    fn g(name: &str) -> GroupRef {
        GroupRef::named(name)
    }

    fn gid(id: &str, name: &str) -> GroupRef {
        GroupRef { id: Some(id.into()), name: name.into() }
    }

    fn group_map() -> RoleMap {
        RoleMap::from_message(&serde_json::json!({ "groups": {
            "admin": ["ElasticPro admins", { "id": "7", "name": "Zabbix administrators" }],
            "operator": ["NOC leads"], "user": ["NOC", "Client A team"], "guest": ["Auditors"] } }), &RoleMap::default()).unwrap()
    }

    #[test]
    fn a_person_in_several_mapped_groups_gets_the_highest_role() {
        let m = group_map();
        let r = m.resolve_claim(Some("User role"), 1, &[g("NOC"), g("NOC leads")]);
        assert_eq!((r.role, r.source.clone()), (Some(Role::Operator), Source::Group("NOC leads".into())));
        assert_eq!(r.matched, vec![("NOC leads".to_string(), Role::Operator), ("NOC".to_string(), Role::User)], "highest first: {r:?}");
        assert_eq!(m.resolve_claim(None, 1, &[g("Auditors"), g("Client A team"), g("ElasticPro admins")]).role, Some(Role::Admin));
        assert_eq!(m.resolve_claim(None, 3, &[g("Auditors")]).role, Some(Role::Guest), "a Super admin in only the guest group is a guest: the groups decide, not the type");
        // Groups are matched exactly, as Zabbix names them.
        assert_eq!(m.resolve_claim(None, 1, &[g("noc")]).matched, vec![], "case matters: \"noc\" is not \"NOC\"");
        assert_eq!(m.resolve_claim(None, 1, &[g(" NOC ")]).role, Some(Role::User), "but surrounding blanks do not");
        let j = r.to_json();
        assert_eq!((j["role"].clone(), j["source"].clone(), j["via"].clone()), (serde_json::json!("operator"), serde_json::json!("group"), serde_json::json!("NOC leads")));
    }

    #[test]
    fn a_group_is_known_by_its_id_across_a_rename_and_by_name_without_one() {
        let m = group_map();
        assert_eq!(m.resolve_claim(None, 1, &[gid("7", "Zabbix admins (renamed)")]).role, Some(Role::Admin), "the id survives a rename");
        assert_eq!(m.resolve_claim(None, 1, &[gid("99", "Zabbix administrators")]).role, Some(Role::User), "both sides have an id and they differ: another group, whatever its name — the fallback decides");
        assert_eq!(m.resolve_claim(None, 1, &[gid("42", "NOC")]).role, Some(Role::User), "a map entry without an id matches by name");
        assert_eq!(m.resolve_claim(None, 1, &[gid("7", "Other")]).role, Some(Role::Admin));
        assert_eq!(m.resolve_claim(None, 1, &[g("Zabbix administrators")]).role, Some(Role::Admin), "a claim without ids (an older module) matches by name");
        // What it round-trips to.
        let j = m.to_json();
        assert_eq!(j["groups"]["admin"], serde_json::json!(["ElasticPro admins", { "id": "7", "name": "Zabbix administrators" }]));
        assert_eq!(j["groups"]["guest"], serde_json::json!(["Auditors"]));
        assert_eq!(j["unmapped"], serde_json::json!("zabbixRole"));
        assert_eq!(RoleMap::from_config(&serde_json::json!({ "roleMap": j })), m, "the file reads back to the same map");
        // Zabbix's own shape is accepted on the way in.
        let z = RoleMap::from_message(&serde_json::json!({ "groups": { "user": [{ "usrgrpid": 12, "name": "NOC" }] } }), &RoleMap::default()).unwrap();
        assert_eq!(z.groups.iter().find(|(r, _)| *r == Role::User).unwrap().1, vec![gid("12", "NOC")]);
    }

    #[test]
    fn in_no_mapped_group_the_unmapped_rule_decides() {
        let m = group_map();
        // The default rule is today's: the Zabbix role name, else the user type.
        let r = m.resolve_claim(None, 2, &[g("Zabbix users")]);
        assert_eq!((r.role, r.source.clone()), (Some(Role::Operator), Source::ZabbixRole));
        assert_eq!(m.resolve_claim(None, 4, &[]).role, None, "a guest type still gets nothing");
        let mut named = m.clone();
        named.names.push(("ES owners".into(), Some(Role::Admin)));
        assert_eq!(named.resolve_claim(Some("ES owners"), 1, &[g("Zabbix users")]).role, Some(Role::Admin), "the older role-name map still works underneath");
        // Or no access.
        let strict = RoleMap::from_message(&serde_json::json!({ "unmapped": "none" }), &m).unwrap();
        let r = strict.resolve_claim(Some("Super admin role"), 3, &[g("Zabbix users")]);
        assert_eq!((r.role, r.source.clone()), (None, Source::Unmapped), "even a Super admin: {r:?}");
        assert!(RoleMap::describe_refusal(None, 3, &[g("Zabbix users")], &r).contains("\"Zabbix users\""));
        assert_eq!(strict.resolve_claim(None, 3, &[g("NOC")]).role, Some(Role::User), "a mapped group still gets in");
        assert_eq!(strict.to_json()["unmapped"], serde_json::json!("none"));
        assert_eq!(Unmapped::parse("no access"), Ok(Unmapped::None));
        assert_eq!(Unmapped::parse("zabbix_role"), Ok(Unmapped::ZabbixRole));
    }

    #[test]
    fn until_a_group_map_is_saved_the_sign_in_is_exactly_the_old_maps() {
        // Migration: a config with only the role-name map, as every site has today.
        let old = RoleMap::from_config(&serde_json::json!({ "roleMap": { "names": { "ES owners": "admin" }, "types": { "2": "user" } } }));
        assert!(!old.group_map_saved());
        assert_eq!(old.resolve_claim(Some("ES owners"), 1, &[g("Anything")]).role, Some(Role::Admin));
        assert_eq!(old.resolve_claim(None, 2, &[g("Anything")]).role, Some(Role::User));
        assert_eq!(old.resolve_claim(None, 3, &[]).role, Some(Role::Admin));
        for (ty, g_) in [(1, vec![]), (2, vec![g("X")]), (3, vec![g("Y"), g("Z")]), (4, vec![])] {
            assert_eq!(old.resolve_claim(None, ty, &g_).role, old.resolve(None, ty), "type {ty}: the group map changes nothing while empty");
        }
        // Saving the group table keeps the old names and types underneath.
        let new = RoleMap::from_message(&serde_json::json!({ "groups": { "operator": ["NOC leads"] } }), &old).unwrap();
        assert!(new.group_map_saved());
        assert_eq!(new.names, old.names, "the role-name map is kept when the message does not mention it");
        assert_eq!(new.types, old.types);
        assert_eq!(new.resolve_claim(Some("ES owners"), 1, &[]).role, Some(Role::Admin));
        assert_eq!(new.resolve_claim(Some("ES owners"), 1, &[g("NOC leads")]).role, Some(Role::Operator), "a mapped group wins over the role name");
        // An explicit empty names table clears it.
        let cleared = RoleMap::from_message(&serde_json::json!({ "names": {} }), &new).unwrap();
        assert!(cleared.names.is_empty() && cleared.groups == new.groups);
        // A file with a malformed groups entry falls back to no group for it, never a lock-out.
        let odd = RoleMap::from_config(&serde_json::json!({ "roleMap": { "groups": { "admin": [7, "", "ok"], "emperor": ["x"] }, "unmapped": "typo" } }));
        assert_eq!(odd.groups.iter().find(|(r, _)| *r == Role::Admin).unwrap().1, vec![g("ok")]);
        assert_eq!(odd.unmapped, Unmapped::ZabbixRole);
    }

    #[test]
    fn the_admins_a_map_leaves_able_to_sign_in_are_counted_from_what_is_known() {
        use crate::auth::{UserStore, ZabbixFacts};
        let s = UserStore::open_with_rounds(None, 1);
        s.add("root", "correct-horse", Role::Admin).unwrap();
        let facts = |ty: i64, groups: &[&str]| Some(ZabbixFacts { user_type: ty, role: None, groups: groups.iter().map(|g_| g(g_)).collect(), at: 1 });
        s.upsert_external_with("zed@zabbix", "zabbix", Role::Admin, None, facts(3, &["Zabbix administrators"])).unwrap();
        s.upsert_external_with("olga@zabbix", "zabbix", Role::Operator, None, facts(2, &["NOC leads"])).unwrap();
        s.upsert_external_with("old@zabbix", "zabbix", Role::Admin, None, None).unwrap();
        let m = group_map();
        assert_eq!(m.admins_able(&s.list()), 2, "root and zed; old's groups are unknown, so it is not counted");
        // Without the local admin, a map that gives zed's group nothing leaves nobody.
        s.remove("root").unwrap();
        assert_eq!(m.admins_able(&s.list()), 1);
        let strict = RoleMap::from_message(&serde_json::json!({ "groups": { "admin": ["Nobody here"] }, "unmapped": "none" }), &m).unwrap();
        assert_eq!(strict.admins_able(&s.list()), 0);
        // A pin counts as it is, whatever the map says; no access counts for nothing.
        s.set_role("olga@zabbix", Role::Admin).unwrap();
        assert_eq!(strict.admins_able(&s.list()), 1);
        s.set_no_access("zed@zabbix").unwrap();
        assert_eq!(m.admins_able(&s.list()), 1, "zed, set to No access, is not able to sign in");
    }

    #[test]
    fn malformed_bodies_are_refused_after_the_signature() {
        let s = sso();
        let b = body("", 1, &[], NOW, "nonce-0000000010");
        assert!(matches!(s.verify(&b, &signed(&b), NOW), Err(SsoError::BadBody(_))));
        let b = body("x", 1, &[], NOW, "short");
        assert!(matches!(s.verify(&b, &signed(&b), NOW), Err(SsoError::BadBody(_))));
        let b = body("x\u{0007}", 1, &[], NOW, "nonce-0000000011");
        assert!(matches!(s.verify(&b, &signed(&b), NOW), Err(SsoError::BadBody(_))));
    }

    #[test]
    fn roles_map_as_agreed() {
        assert_eq!(role_for(1), Some(Role::User));
        assert_eq!(role_for(2), Some(Role::Operator));
        assert_eq!(role_for(3), Some(Role::Admin));
        assert_eq!(role_for(4), None);
        assert_eq!(role_for(0), None);
    }

    #[test]
    fn every_zabbix_sign_in_reads_every_cluster_by_default() {
        let g = vec!["ES vm-1".to_string()];
        assert_eq!(scope_for(Role::User, &g, false), None);
        assert_eq!(scope_for(Role::User, &[], false), None);
        assert_eq!(scope_for(Role::Operator, &g, false), None);
    }

    #[test]
    fn with_scoping_on_only_a_zabbix_user_is_scoped() {
        let g = vec![" ES vm-1 ".to_string(), "".to_string(), "ES vm-1".to_string()];
        assert_eq!(scope_for(Role::User, &g, true), Some(vec!["ES vm-1".to_string()]));
        assert_eq!(scope_for(Role::Operator, &g, true), None);
        assert_eq!(scope_for(Role::Admin, &g, true), None);
        // In no group at all is still scoped — to nothing.
        assert_eq!(scope_for(Role::User, &[], true), Some(vec![]));
    }

    fn role_body(user: &str, ty: i64, ts: u64, nonce: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "zabbix_user": user, "zabbix_user_type": ty, "ts": ts, "nonce": nonce })).unwrap()
    }

    #[test]
    fn a_role_lookup_is_signed_clocked_and_asked_once() {
        let s = sso();
        let b = role_body("alice", 2, NOW, "rnonce-000000001");
        let q = s.verify_role_query(&b, &signed(&b), NOW).unwrap();
        assert_eq!((q.zabbix_user.as_str(), q.zabbix_user_type), ("alice", 2));
        assert_eq!(s.verify_role_query(&b, &signed(&b), NOW), Err(SsoError::Replayed));
        let b = role_body("alice", 2, NOW, "rnonce-000000002");
        let wrong = ZabbixSso::sign(b"another-secret-that-is-long-enough-000", &b);
        assert_eq!(s.verify_role_query(&b, &wrong, NOW), Err(SsoError::BadSignature));
        let old = role_body("alice", 2, NOW - MAX_SKEW_SECS - 1, "rnonce-000000003");
        assert_eq!(s.verify_role_query(&old, &signed(&old), NOW), Err(SsoError::Stale));
        let short = role_body("alice", 2, NOW, "short");
        assert!(matches!(s.verify_role_query(&short, &signed(&short), NOW), Err(SsoError::BadBody(_))));
        let b = role_body("alice", 2, NOW, "rnonce-000000004");
        assert_eq!(ZabbixSso::default().verify_role_query(&b, &signed(&b), NOW), Err(SsoError::NotConfigured));
    }

    #[test]
    fn a_guest_may_be_asked_about() {
        // Read-only: the answer for a type with no role is "none from Zabbix", not a refusal.
        let b = role_body("guest", 4, NOW, "rnonce-000000005");
        assert!(sso().verify_role_query(&b, &signed(&b), NOW).is_ok());
    }

    #[test]
    fn the_answer_is_signed_over_the_questions_ts_and_nonce() {
        let s = sso();
        let body = br#"{"ok":true,"role":"admin"}"#;
        let sig = s.sign_reply(NOW, "rnonce-000000006", body).unwrap();
        assert_eq!(sig, ZabbixSso::sign(SECRET.as_bytes(), format!("{NOW}\nrnonce-000000006\n{{\"ok\":true,\"role\":\"admin\"}}").as_bytes()));
        assert_ne!(sig, s.sign_reply(NOW, "rnonce-000000007", body).unwrap(), "another question, another signature");
        assert_ne!(sig, s.sign_reply(NOW + 1, "rnonce-000000006", body).unwrap());
        assert!(ZabbixSso::default().sign_reply(NOW, "n", body).is_none());
    }

    #[test]
    fn names_are_namespaced() {
        assert_eq!(account_name(" Admin "), "Admin@zabbix");
    }

    #[test]
    fn a_code_is_spent_on_first_use() {
        let s = sso();
        let code = s.issue_code("alice@zabbix");
        assert_eq!(s.redeem(&code).as_deref(), Some("alice@zabbix"));
        assert_eq!(s.redeem(&code), None);
        assert_eq!(s.redeem("not-a-code"), None);
    }

    #[test]
    fn an_expired_code_is_worthless() {
        let s = sso().with_code_ttl(Duration::from_millis(0));
        let code = s.issue_code("alice@zabbix");
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(s.redeem(&code), None);
    }

    #[test]
    fn sweep_expired_forgets_old_codes_and_nonces_and_a_dry_run_only_counts() {
        let s = sso().with_code_ttl(Duration::from_millis(0));
        let b = body("alice", 1, &[], NOW, "nonce-0000000002");
        s.verify(&b, &signed(&b), NOW).unwrap();
        s.issue_code("alice@zabbix");
        // The code's ttl is zero: it is already past. The nonce is young.
        assert_eq!(s.sweep_expired(true), 1);
        assert_eq!(s.codes.lock().len(), 1);
        assert_eq!(s.sweep_expired(false), 1);
        assert!(s.codes.lock().is_empty());
        assert_eq!(s.nonces.lock().len(), 1, "a nonce still inside the replay window stays");
        s.nonces.lock().insert("old".into(), Instant::now() - Duration::from_secs(MAX_SKEW_SECS * 2 + 10));
        assert_eq!(s.sweep_expired(false), 1);
        assert_eq!(s.nonces.lock().len(), 1);
    }
}
