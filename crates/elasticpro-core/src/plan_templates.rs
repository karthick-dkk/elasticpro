//! Plan templates: the roles, sizing rules and server specs Reports › Planning sizes a new or
//! existing cluster from (docs/REPORTS.md, "Planning (board 8) and Plan templates (board 10)").
//!
//! Shared server-side settings: any signed-in user reads them (`PLAN_TEMPLATES_GET`), an
//! administrator who sees every cluster replaces the whole list (`PLAN_TEMPLATES_SET`), the
//! change is audited and lands in the activity log as `plan_templates_set`.
//!
//! Hosted only on disk (`<data dir>/plan-templates.json`, 0600). A missing file reads as the
//! two seeded templates, **Standard** and **Small / lab**. The desktop build keeps templates in
//! the browser (the page decides; this store then answers from memory only).
//!
//! A template:
//! `{name, backup: "disk"|"s3"|"ulm", roles: [role]}`; a role:
//! `{on, name, rule, cpu, ram, root, notes, ...rule fields}` where `rule` is one of
//! `volume` (`cap`: GB per day per server), `fixed` (`count`), `tier` (`tier`: hot|warm,
//! `nodeTB`), `whenData` (`count` from `from` data nodes), `follows` (`of`: another role's name,
//! `per`: one per N of it) or `target` (`target`: s3|ulm, `cap` for ulm). Every number is a
//! number >= 0 or `null` (= "[set]": not given yet, never taken as 0).

use crate::auth::{Caller, Edition, Role};
use crate::bridge::Core;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

pub const FILE: &str = "plan-templates.json";
pub const MAX_TEMPLATES: usize = 50;
pub const MAX_ROLES: usize = 60;
pub const MAX_NAME: usize = 60;
pub const MAX_NOTES: usize = 200;
pub const MAX_BYTES: usize = 256 * 1024;
pub const RULES: [&str; 6] = ["volume", "fixed", "tier", "whenData", "follows", "target"];
pub const BACKUPS: [&str; 3] = ["disk", "s3", "ulm"];

/// The two templates a fresh install holds, until an administrator saves.
pub fn seed() -> Vec<Value> {
    let role = |name: &str, rule: &str, extra: Value, cpu: Value, ram: Value, notes: &str| {
        let mut r = json!({ "on": true, "name": name, "rule": rule, "cpu": cpu, "ram": ram, "root": null, "notes": notes });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            r[k] = v;
        }
        r
    };
    let n = Value::Null;
    vec![
        json!({
            "name": "Standard", "backup": "disk",
            "roles": [
                role("Forwarder", "volume", json!({ "cap": 150 }), json!(8), json!(16), "syslog / auditbeat / beats"),
                role("Parser", "volume", json!({ "cap": 150 }), json!(8), json!(16), "same as forwarder"),
                role("Elasticsearch hot", "tier", json!({ "tier": "hot", "nodeTB": 8 }), n.clone(), n.clone(), "one node holds every role"),
                role("Elasticsearch warm", "tier", json!({ "tier": "warm", "nodeTB": null }), n.clone(), n.clone(), "larger, slower disks"),
                role("Elasticsearch master", "whenData", json!({ "count": 3, "from": 3 }), n.clone(), n.clone(), "odd count for quorum"),
                role("Elasticsearch coordinating", "whenData", json!({ "count": 2, "from": null }), n.clone(), n.clone(), "search / ingest front"),
                role("Engine", "volume", json!({ "cap": null }), n.clone(), n.clone(), ""),
                role("AI/ML", "fixed", json!({ "count": 1 }), n.clone(), n.clone(), ""),
                role("ULM", "target", json!({ "target": "ulm", "cap": null }), n.clone(), n.clone(), "used when backups go to ULM"),
                role("S3 backup", "target", json!({ "target": "s3" }), n.clone(), n.clone(), "used when backups go to S3"),
                role("Other servers", "fixed", json!({ "count": null }), n.clone(), n.clone(), "e.g. jump host, UI"),
            ],
        }),
        json!({
            "name": "Small / lab", "backup": "s3",
            "roles": [
                role("Forwarder", "fixed", json!({ "count": 1 }), json!(8), json!(16), ""),
                role("Elasticsearch hot", "tier", json!({ "tier": "hot", "nodeTB": 8 }), n.clone(), n.clone(), ""),
                role("S3 backup", "target", json!({ "target": "s3" }), n.clone(), n.clone(), ""),
            ],
        }),
    ]
}

fn text(v: &Value, what: &str, max: usize, required: bool) -> Result<String, String> {
    let s = match v {
        Value::Null if !required => return Ok(String::new()),
        Value::String(s) => s.trim().to_string(),
        _ => return Err(format!("{what} must be text")),
    };
    if required && s.is_empty() {
        return Err(format!("{what} cannot be empty"));
    }
    if s.chars().count() > max || s.chars().any(char::is_control) {
        return Err(format!("{what}: at most {max} characters, no control characters"));
    }
    Ok(s)
}

/// `null` / absent is "not set"; otherwise a finite number >= 0 (`whole`: an integer).
fn number(r: &Value, key: &str, what: &str, whole: bool) -> Result<Value, String> {
    match r.get(key) {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if !f.is_finite() || f < 0.0 {
                return Err(format!("{what} must be a number of 0 or more, or empty"));
            }
            if whole && f.fract() != 0.0 {
                return Err(format!("{what} must be a whole number"));
            }
            if f > 1.0e9 {
                return Err(format!("{what} is too large"));
            }
            Ok(Value::Number(n.clone()))
        }
        Some(_) => Err(format!("{what} must be a number of 0 or more, or empty")),
    }
}

fn parse_role(r: &Value, i: usize) -> Result<Value, String> {
    let o = r.as_object().ok_or_else(|| format!("role {}: an object", i + 1))?;
    let name = text(o.get("name").unwrap_or(&Value::Null), &format!("role {} name", i + 1), MAX_NAME, true)?;
    let at = |what: &str| format!("{name}: {what}");
    let rule = o.get("rule").and_then(Value::as_str).unwrap_or("");
    if !RULES.contains(&rule) {
        return Err(at(&format!("rule must be one of {}, not {rule:?}", RULES.join(", "))));
    }
    let on = match o.get("on") {
        None => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(at("on must be true or false")),
    };
    let mut out = Map::new();
    out.insert("on".into(), json!(on));
    out.insert("name".into(), json!(name));
    out.insert("rule".into(), json!(rule));
    out.insert("cpu".into(), number(r, "cpu", &at("CPU"), false)?);
    out.insert("ram".into(), number(r, "ram", &at("RAM"), false)?);
    out.insert("root".into(), number(r, "root", &at("/ disk"), false)?);
    out.insert("notes".into(), json!(text(o.get("notes").unwrap_or(&Value::Null), &at("notes"), MAX_NOTES, false)?));
    match rule {
        "volume" => {
            out.insert("cap".into(), number(r, "cap", &at("GB per day per server"), false)?);
        }
        "fixed" => {
            out.insert("count".into(), number(r, "count", &at("count"), true)?);
        }
        "tier" => {
            let tier = o.get("tier").and_then(Value::as_str).unwrap_or("");
            if tier != "hot" && tier != "warm" {
                return Err(at(&format!("tier must be hot or warm, not {tier:?}")));
            }
            out.insert("tier".into(), json!(tier));
            out.insert("nodeTB".into(), number(r, "nodeTB", &at("node size (TB)"), false)?);
        }
        "whenData" => {
            out.insert("count".into(), number(r, "count", &at("count"), true)?);
            out.insert("from".into(), number(r, "from", &at("from this many data nodes"), true)?);
        }
        "follows" => {
            out.insert("of".into(), json!(text(o.get("of").unwrap_or(&Value::Null), &at("follows"), MAX_NAME, true)?));
            out.insert("per".into(), number(r, "per", &at("one per N"), true)?);
        }
        _ => {
            let t = o.get("target").and_then(Value::as_str).unwrap_or("");
            if t != "s3" && t != "ulm" {
                return Err(at(&format!("target must be s3 or ulm, not {t:?}")));
            }
            out.insert("target".into(), json!(t));
            if t == "ulm" {
                out.insert("cap".into(), number(r, "cap", &at("GB per day per server"), false)?);
            }
        }
    }
    Ok(Value::Object(out))
}

/// The list as it will be kept, or what is wrong with it. Names are unique (case-insensitive),
/// as are the role names inside one template; `follows` names a role that exists, not itself,
/// and never loops back.
pub fn parse(list: &Value) -> Result<Vec<Value>, String> {
    let Some(arr) = list.as_array() else { return Err("templates: a list".into()) };
    if arr.is_empty() {
        return Err("templates: keep at least one template".into());
    }
    if arr.len() > MAX_TEMPLATES {
        return Err(format!("templates: at most {MAX_TEMPLATES}"));
    }
    if serde_json::to_vec(list).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_BYTES {
        return Err(format!("templates: more than {} KB", MAX_BYTES / 1024));
    }
    let mut out = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for (ti, t) in arr.iter().enumerate() {
        let name = text(t.get("name").unwrap_or(&Value::Null), &format!("template {} name", ti + 1), MAX_NAME, true)?;
        if names.contains(&name.to_lowercase()) {
            return Err(format!("template names must be unique: {name:?} is used twice"));
        }
        names.push(name.to_lowercase());
        let backup = t.get("backup").and_then(Value::as_str).unwrap_or("disk");
        if !BACKUPS.contains(&backup) {
            return Err(format!("{name}: backup must be disk, s3 or ulm, not {backup:?}"));
        }
        let roles = t.get("roles").and_then(Value::as_array).ok_or_else(|| format!("{name}: roles must be a list"))?;
        if roles.len() > MAX_ROLES {
            return Err(format!("{name}: at most {MAX_ROLES} roles"));
        }
        let mut parsed = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for (i, r) in roles.iter().enumerate() {
            let p = parse_role(r, i).map_err(|e| format!("{name}: {e}"))?;
            let rn = p["name"].as_str().unwrap_or("").to_lowercase();
            if seen.contains(&rn) {
                return Err(format!("{name}: role names must be unique: {:?} is used twice", p["name"].as_str().unwrap_or("")));
            }
            seen.push(rn);
            parsed.push(p);
        }
        // `follows`: the target exists, is not the role itself, and the chain ends.
        let target_of = |role: &Value| -> Option<String> {
            (role["rule"] == "follows").then(|| role["of"].as_str().unwrap_or("").to_lowercase())
        };
        for p in &parsed {
            let me = p["name"].as_str().unwrap_or("").to_lowercase();
            let mut at = target_of(p);
            let mut hops = 0;
            while let Some(next) = at {
                let Some(r) = parsed.iter().find(|q| q["name"].as_str().unwrap_or("").to_lowercase() == next) else {
                    return Err(format!("{name}: {:?} follows {next:?}, which is not a role of this template", p["name"].as_str().unwrap_or("")));
                };
                if next == me || hops > parsed.len() {
                    return Err(format!("{name}: {:?} follows itself, directly or through other roles", p["name"].as_str().unwrap_or("")));
                }
                hops += 1;
                at = target_of(r);
            }
        }
        out.push(json!({ "name": name, "backup": backup, "roles": parsed }));
    }
    Ok(out)
}

/// What is kept, and where.
pub struct PlanTemplates {
    path: Option<PathBuf>,
    kept: Mutex<Option<Stored>>,
}

#[derive(Clone)]
struct Stored {
    templates: Vec<Value>,
    by: String,
    at: u64,
}

impl PlanTemplates {
    /// `path`: the file (hosted), or `None` to hold them in memory only.
    pub fn open(path: Option<PathBuf>) -> PlanTemplates {
        let kept = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| {
            // A hand-edited or damaged file falls back to the seeds rather than hiding the page.
            let templates = parse(v.get("templates")?).ok()?;
            Some(Stored { templates, by: v["updatedBy"].as_str().unwrap_or("").into(), at: v["updatedAt"].as_u64().unwrap_or(0) })
        });
        PlanTemplates { path, kept: Mutex::new(kept) }
    }

    fn view(&self) -> Value {
        match &*self.kept.lock() {
            Some(s) => json!({ "templates": s.templates, "custom": true, "updatedBy": s.by, "updatedAt": s.at }),
            None => json!({ "templates": seed(), "custom": false }),
        }
    }

    /// The templates as kept, or `None` while the seeds serve (nothing saved yet).
    pub(crate) fn kept(&self) -> Option<Vec<Value>> {
        self.kept.lock().as_ref().map(|s| s.templates.clone())
    }

    /// Validate a list the way `PLAN_TEMPLATES_SET` does.
    pub(crate) fn check(list: &Value) -> Result<Vec<Value>, String> {
        parse(list)
    }

    pub(crate) fn replace(&self, templates: Vec<Value>, by: &str, at: u64) -> Result<(), String> {
        let mut g = self.kept.lock();
        if let Some(p) = &self.path {
            let body = serde_json::to_vec_pretty(&json!({ "templates": templates, "updatedBy": by, "updatedAt": at })).map_err(|e| e.to_string())?;
            crate::play::write_private(p, &body)?;
        }
        *g = Some(Stored { templates, by: by.into(), at });
        Ok(())
    }
}

fn bad(kind: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "kind": kind, "message": message.into() })
}

impl Core {
    /// `PLAN_TEMPLATES_GET` (any signed-in user; a display link is refused at the gate) →
    /// `{ok, templates, custom, updatedBy?, updatedAt?}`. `PLAN_TEMPLATES_SET {templates}`
    /// (administrator, with no cluster limit: the templates are shared by every cluster's
    /// plan, like Play's fleet-wide settings) replaces the list and answers as GET.
    pub(crate) fn plan_templates_msg(&self, t: &str, msg: &Value, caller: Option<&Caller>) -> Value {
        let mut out = self.plan_templates.view();
        if t == "PLAN_TEMPLATES_SET" {
            if caller.is_some_and(|c| c.limited() || c.role < Role::Admin) {
                return bad("forbidden", "plan templates are shared by every cluster: they need an administrator who sees every cluster");
            }
            let Some(list) = msg.get("templates") else { return bad("bad_request", "templates: the whole list, an array") };
            let templates = match parse(list) {
                Ok(t) => t,
                Err(e) => return bad("bad_request", e),
            };
            let by = caller.map(|c| c.name.clone()).unwrap_or_else(|| "local".into());
            let at = crate::fleet::now_ms();
            let before = self.plan_templates.view()["templates"].clone();
            if let Err(e) = self.plan_templates.replace(templates.clone(), &by, at) {
                return bad("io", format!("the plan templates could not be saved: {e}"));
            }
            let names: Vec<&str> = templates.iter().filter_map(|t| t["name"].as_str()).collect();
            tracing::info!(target: "audit", user = %by, templates = %names.join(", "), changed = (before != json!(templates)), "plan templates changed");
            out = self.plan_templates.view();
        }
        out["ok"] = json!(true);
        out
    }

    pub(crate) fn plan_templates_store(edition: Edition, data_dir: Option<&std::path::Path>) -> PlanTemplates {
        PlanTemplates::open(data_dir.filter(|_| edition == Edition::Hosted).map(|d| d.join(FILE)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seeds_validate_and_round_trip() {
        let s = seed();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0]["name"], "Standard");
        assert_eq!(s[0]["roles"].as_array().unwrap().len(), 11);
        assert_eq!(parse(&json!(s)).unwrap(), s, "what the seeds say is what validation keeps");
    }

    #[test]
    fn names_numbers_and_rules_are_checked() {
        let one = |roles: Value| parse(&json!([{ "name": "T", "backup": "disk", "roles": roles }]));
        assert!(parse(&json!([])).is_err());
        assert!(parse(&json!("x")).is_err());
        let twice = parse(&json!([{ "name": "A", "roles": [] }, { "name": " a ", "roles": [] }])).unwrap_err();
        assert!(twice.contains("unique"), "{twice}");
        assert!(parse(&json!([{ "name": "A", "backup": "tape", "roles": [] }])).unwrap_err().contains("backup"));
        assert!(one(json!([{ "name": "x", "rule": "magic" }])).unwrap_err().contains("rule"));
        assert!(one(json!([{ "name": "x", "rule": "volume", "cap": -1 }])).unwrap_err().contains("0 or more"));
        assert!(one(json!([{ "name": "x", "rule": "volume", "cap": "150" }])).is_err());
        assert!(one(json!([{ "name": "x", "rule": "fixed", "count": 1.5 }])).unwrap_err().contains("whole"));
        assert!(one(json!([{ "name": "x", "rule": "tier", "tier": "cold" }])).unwrap_err().contains("hot or warm"));
        assert!(one(json!([{ "name": "x", "rule": "target", "target": "disk" }])).unwrap_err().contains("s3 or ulm"));
        assert!(one(json!([{ "name": "x", "rule": "fixed" }, { "name": "X", "rule": "fixed" }])).unwrap_err().contains("unique"));
        assert!(one(json!([{ "name": "", "rule": "fixed" }])).is_err());
        let ok = one(json!([{ "name": "x", "rule": "volume", "cap": 0, "cpu": null }])).unwrap();
        assert_eq!(ok[0]["roles"][0]["cap"], json!(0), "0 is kept as typed; the page treats it as not set");
        assert_eq!(ok[0]["roles"][0]["ram"], Value::Null);
    }

    #[test]
    fn follows_must_end_at_a_real_role() {
        let t = |roles: Value| parse(&json!([{ "name": "T", "roles": roles }]));
        assert!(t(json!([{ "name": "P", "rule": "fixed", "count": 3 }, { "name": "Q", "rule": "follows", "of": "p", "per": 3 }])).is_ok());
        assert!(t(json!([{ "name": "Q", "rule": "follows", "of": "Nope", "per": 3 }])).unwrap_err().contains("not a role"));
        assert!(t(json!([{ "name": "Q", "rule": "follows", "of": "Q", "per": 3 }])).unwrap_err().contains("itself"));
        let loop2 = t(json!([{ "name": "A", "rule": "follows", "of": "B", "per": 1 }, { "name": "B", "rule": "follows", "of": "A", "per": 1 }]));
        assert!(loop2.unwrap_err().contains("itself"));
    }

    #[test]
    fn size_is_bounded() {
        let roles: Vec<Value> = (0..=MAX_ROLES).map(|i| json!({ "name": format!("r{i}"), "rule": "fixed", "count": 1 })).collect();
        assert!(parse(&json!([{ "name": "T", "roles": roles }])).unwrap_err().contains("at most"));
        let long = "x".repeat(MAX_NAME + 1);
        assert!(parse(&json!([{ "name": long, "roles": [] }])).is_err());
    }
}
