//! What changed between two versions of the config, in a line a person can read in the
//! version list: "Clusters · client-f-stage added; Defaults · watchMinutes 15 → 20".
//!
//! Computed here, from the two texts, never taken from the browser: the UI could describe
//! a save as anything, and a history that says what the saver claimed is not a history.
//!
//! The config holds credentials. No value under a key that looks like one — password,
//! token, api key, secret, authorization — is ever written into a summary; the line says
//! "credential changed" and nothing more. A value is shown only when it is a short scalar;
//! anything longer is "changed". The summary is bounded (`MAX_ITEMS`, `MAX_LEN`) so a
//! sweeping edit reads as "… +12 more", not as the whole file.

use serde_json::Value;

/// How many changes are named before "+N more".
pub const MAX_ITEMS: usize = 4;
/// The longest summary stored.
pub const MAX_LEN: usize = 240;
/// A scalar longer than this is "changed", not shown.
const MAX_SHOWN: usize = 32;
/// What the summary says when either text does not parse as a config.
pub const UNPARSED: &str = "config text changed";
/// What it says when the texts differ but the values do not (a reformat, a comment).
pub const NO_VALUE_CHANGE: &str = "no change in values";

/// A key whose value is a credential. Matched on the key's name, case-insensitively, so
/// `apiKey`, `api_key`, `Authorization` and `zabbixToken` are all caught; `keyFile` is a
/// path and is not.
pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("password") || k.contains("passwd") || k.contains("passphrase") || k.contains("secret") || k.contains("token")
        || k.contains("apikey") || k.contains("api_key") || k.contains("authorization") || k.contains("credential")
        || k.contains("privatekey") || k.contains("private_key") || k.contains("sshkey") || k.contains("ssh_key")
        // `x-api-key`, `service_key`, … — a key named "…key" holds one; `keyFile` names a path.
        || k.ends_with("-key") || k.ends_with("_key")
        || matches!(k.as_str(), "auth" | "headers" | "master" | "basic" | "pass" | "key")
}

/// Whether a string carries `user:password@` — a URL with credentials in it, or the bare
/// authority of one. Such a value never reaches a summary as it is.
fn has_userinfo(s: &str) -> bool {
    let rest = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    authority.contains('@')
}

/// A URL with its `user:password@` removed, so a cluster can still be named by its address.
/// Anything without userinfo comes back unchanged.
pub fn redact_url(s: &str) -> String {
    let Some((scheme, rest)) = s.split_once("://") else {
        return if has_userinfo(s) { s.rsplit_once('@').map(|(_, h)| h.to_string()).unwrap_or_default() } else { s.to_string() };
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    format!("{scheme}://{host}{tail}")
}

/// The section name a person knows a top-level key by.
fn section_label(key: &str) -> String {
    match key {
        "clusters" | "hosts" => "Clusters",
        "defaults" => "Defaults",
        "credentials" => "Credentials",
        "jump_hosts" | "jumpHosts" => "Jump hosts",
        "zabbix" => "Zabbix",
        "automations" => "Automation",
        "alerts" | "alertRules" | "alert_rules" => "Alert triggers",
        "mail" => "Mail delivery",
        "reports" | "volume" => "Reports",
        "play" => "Play",
        other => other,
    }
    .to_string()
}

/// A scalar as the summary shows it, or `None` when it should only be called "changed".
fn short(v: &Value) -> Option<String> {
    match v {
        Value::Null => Some("none".into()),
        Value::Bool(b) => Some(if *b { "on" } else { "off" }.into()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => {
            let s = s.trim();
            // A value with `user:password@` in it is a credential whatever its key is called:
            // "changed", never the text.
            (!s.is_empty() && s.chars().count() <= MAX_SHOWN && !s.contains('\n') && !has_userinfo(s)).then(|| s.to_string())
        }
        Value::Array(a) if a.iter().all(|x| !x.is_object() && !x.is_array()) => {
            let parts: Vec<String> = a.iter().filter_map(short).collect();
            let joined = format!("[{}]", parts.join(", "));
            (parts.len() == a.len() && joined.chars().count() <= MAX_SHOWN).then_some(joined)
        }
        _ => None,
    }
}

/// `a → b`, or "changed" when either side is not worth showing.
fn scalar_change(field: &str, old: &Value, new: &Value) -> String {
    match (short(old), short(new)) {
        (Some(a), Some(b)) => format!("{field} {a} → {b}"),
        _ => format!("{field} changed"),
    }
}

/// How a list entry is named: a cluster by its name or id, a jump host by its host, a rule by its id.
fn identity(v: &Value) -> Option<String> {
    ["id", "name", "host", "url"].iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))
        // A cluster named only by a URL that carries `user:password@` is named by its address.
        .map(redact_url)
}

/// The fields of one object that differ from another, secrets collapsed to "credential".
fn changed_fields(old: &Value, new: &Value) -> Vec<String> {
    let (Some(o), Some(n)) = (old.as_object(), new.as_object()) else { return vec!["value".into()] };
    let mut keys: Vec<&String> = o.keys().chain(n.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut out: Vec<String> = vec![];
    for k in keys {
        if o.get(k) == n.get(k) {
            continue;
        }
        let name = if is_secret_key(k) { "credential".to_string() } else { k.clone() };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

fn fields_note(fields: &[String]) -> String {
    const SHOW: usize = 3;
    if fields.is_empty() {
        return String::new();
    }
    let shown: Vec<&str> = fields.iter().take(SHOW).map(String::as_str).collect();
    let more = fields.len().saturating_sub(SHOW);
    if more > 0 {
        format!(" ({}, +{more} more)", shown.join(", "))
    } else {
        format!(" ({})", shown.join(", "))
    }
}

/// Entries of a list of objects, matched by identity: added, removed, changed.
fn list_changes(label: &str, old: &[Value], new: &[Value], out: &mut Vec<String>) {
    let named = |v: &[Value]| v.iter().all(|x| x.is_object() && identity(x).is_some());
    if !named(old) || !named(new) {
        if old.len() != new.len() {
            out.push(format!("{label} · {} entries → {}", old.len(), new.len()));
        } else {
            out.push(format!("{label} changed"));
        }
        return;
    }
    let find = |list: &[Value], id: &str| list.iter().find(|x| identity(x).as_deref() == Some(id)).cloned();
    let mut seen: Vec<String> = vec![];
    for o in old {
        let id = identity(o).unwrap_or_default();
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        match find(new, &id) {
            None => out.push(format!("{label} · {id} removed")),
            Some(n) if n != *o => {
                let f = changed_fields(o, &n);
                if f.len() == 1 && f[0] == "credential" {
                    out.push(format!("{label} · {id} credential changed"));
                } else {
                    out.push(format!("{label} · {id} changed{}", fields_note(&f)));
                }
            }
            Some(_) => {}
        }
    }
    for n in new {
        let id = identity(n).unwrap_or_default();
        if !seen.contains(&id) {
            seen.push(id.clone());
            out.push(format!("{label} · {id} added"));
        }
    }
}

/// A section that is a mapping: each child a line of its own.
fn map_changes(label: &str, old: &serde_json::Map<String, Value>, new: &serde_json::Map<String, Value>, out: &mut Vec<String>) {
    let mut keys: Vec<&String> = old.keys().chain(new.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut credential_said = false;
    for k in keys {
        let (o, n) = (old.get(k), new.get(k));
        if o == n {
            continue;
        }
        if is_secret_key(k) {
            if !credential_said {
                out.push(format!("{label} · credential changed"));
                credential_said = true;
            }
            continue;
        }
        match (o, n) {
            (None, Some(_)) => out.push(format!("{label} · {k} added")),
            (Some(_), None) => out.push(format!("{label} · {k} removed")),
            (Some(a), Some(b)) if a.is_object() && b.is_object() => {
                let f = changed_fields(a, b);
                if f.len() == 1 && f[0] == "credential" {
                    out.push(format!("{label} · {k} credential changed"));
                } else {
                    out.push(format!("{label} · {k} changed{}", fields_note(&f)));
                }
            }
            (Some(a), Some(b)) if a.is_array() && b.is_array() => {
                out.push(format!("{label} · {}", scalar_change(k, a, b)));
            }
            (Some(a), Some(b)) => out.push(format!("{label} · {}", scalar_change(k, a, b))),
            (None, None) => {}
        }
    }
}

/// Every change between two parsed configs, one line each, unbounded. `summarize` bounds it.
pub fn changes(old: &Value, new: &Value) -> Vec<String> {
    let mut out = vec![];
    let (Some(o), Some(n)) = (old.as_object(), new.as_object()) else {
        if old != new {
            out.push("config changed".into());
        }
        return out;
    };
    let mut keys: Vec<&String> = o.keys().chain(n.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        let label = section_label(k);
        let (a, b) = (o.get(k), n.get(k));
        if a == b {
            continue;
        }
        if is_secret_key(k) || k == "credentials" {
            out.push(format!("{label} · credential changed"));
            continue;
        }
        match (a, b) {
            (None, Some(_)) => out.push(format!("{label} added")),
            (Some(_), None) => out.push(format!("{label} removed")),
            (Some(Value::Array(x)), Some(Value::Array(y))) => list_changes(&label, x, y, &mut out),
            (Some(Value::Object(x)), Some(Value::Object(y))) => map_changes(&label, x, y, &mut out),
            (Some(x), Some(y)) => out.push(scalar_change(&label, x, y)),
            (None, None) => {}
        }
    }
    out
}

/// The one line kept with a version: at most `MAX_ITEMS` changes, then "+N more", cut at
/// `MAX_LEN`. `NO_VALUE_CHANGE` when the values are the same.
pub fn summarize(old: &Value, new: &Value) -> String {
    let all = changes(old, new);
    if all.is_empty() {
        return NO_VALUE_CHANGE.into();
    }
    let more = all.len().saturating_sub(MAX_ITEMS);
    let mut s = all.iter().take(MAX_ITEMS).cloned().collect::<Vec<_>>().join("; ");
    if more > 0 {
        s.push_str(&format!("; +{more} more"));
    }
    if s.chars().count() > MAX_LEN {
        s = s.chars().take(MAX_LEN - 1).collect::<String>() + "…";
    }
    s
}

/// `summarize` on two config texts (JSON or YAML). `UNPARSED` when either does not parse —
/// said as such rather than guessed at. An empty old text is "nothing was there".
pub fn summarize_text(old: &str, new: &str) -> String {
    let parse = |t: &str| if t.trim().is_empty() { Ok(Value::Object(Default::default())) } else { crate::bridge::parse_config_text(t) };
    match (parse(old), parse(new)) {
        (Ok(a), Ok(b)) => summarize(&a, &b),
        _ => UNPARSED.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_cluster_added_is_named_by_its_name() {
        let old = json!({ "clusters": [{ "name": "client-a", "url": "http://a:9200" }] });
        let new = json!({ "clusters": [{ "name": "client-a", "url": "http://a:9200" }, { "name": "client-f-stage", "url": "http://f:9200" }] });
        assert_eq!(summarize(&old, &new), "Clusters · client-f-stage added");
        assert_eq!(summarize(&new, &old), "Clusters · client-f-stage removed");
    }

    #[test]
    fn a_scalar_shows_both_values_and_a_long_one_does_not() {
        let old = json!({ "defaults": { "watchMinutes": 15, "note": "x".repeat(80), "live": true } });
        let new = json!({ "defaults": { "watchMinutes": 20, "note": "y".repeat(80), "live": false } });
        assert_eq!(summarize(&old, &new), "Defaults · live on → off; Defaults · note changed; Defaults · watchMinutes 15 → 20");
    }

    #[test]
    fn secrets_are_never_written_into_the_summary() {
        let old = json!({ "credentials": { "username": "elastic", "password": "hunter2" },
                          "clusters": [{ "name": "c1", "url": "http://c1", "apiKey": "AAAA-old" }],
                          "zabbix": { "url": "http://z", "token": "tok-old" } });
        let new = json!({ "credentials": { "username": "elastic", "password": "hunter3" },
                          "clusters": [{ "name": "c1", "url": "http://c1", "apiKey": "BBBB-new" }],
                          "zabbix": { "url": "http://z", "token": "tok-new" } });
        let s = summarize(&old, &new);
        for leak in ["hunter", "AAAA", "BBBB", "tok-old", "tok-new"] {
            assert!(!s.contains(leak), "{leak} leaked into {s:?}");
        }
        assert_eq!(s, "Clusters · c1 credential changed; Credentials · credential changed; Zabbix · credential changed");
        // A credential alongside a plain field: the field is named, the credential is not shown.
        let new2 = json!({ "credentials": old["credentials"], "clusters": [{ "name": "c1", "url": "http://c2", "apiKey": "BBBB-new" }], "zabbix": old["zabbix"] });
        assert_eq!(summarize(&old, &new2), "Clusters · c1 changed (credential, url)");
    }

    #[test]
    fn a_map_section_names_its_children() {
        let old = json!({ "jump_hosts": { "jumpwin": { "host": "a", "port": 22 } } });
        let new = json!({ "jump_hosts": { "jumpwin": { "host": "b", "port": 22 }, "jumplin": { "host": "c" } } });
        assert_eq!(summarize(&old, &new), "Jump hosts · jumplin added; Jump hosts · jumpwin changed (host)");
    }

    #[test]
    fn sections_added_removed_and_the_whole_thing_bounded() {
        let old = json!({ "clusters": [] });
        let new = json!({ "clusters": [], "automations": [{ "id": "r1" }], "mail": { "host": "m" } });
        assert_eq!(summarize(&old, &new), "Automation added; Mail delivery added");
        let many = json!({ "defaults": { "a": 1, "b": 1, "c": 1, "d": 1, "e": 1, "f": 1 } });
        let many2 = json!({ "defaults": { "a": 2, "b": 2, "c": 2, "d": 2, "e": 2, "f": 2 } });
        let s = summarize(&many, &many2);
        assert!(s.ends_with("; +2 more"), "{s}");
        assert_eq!(s.matches("→").count(), 4);
        assert!(summarize(&old, &old) == NO_VALUE_CHANGE);
    }

    #[test]
    fn a_list_without_identities_is_counted_not_named() {
        let old = json!({ "alerts": [1, 2] });
        let new = json!({ "alerts": [1, 2, 3] });
        assert_eq!(summarize(&old, &new), "Alert triggers · 2 entries → 3");
        let new2 = json!({ "alerts": [1, 3] });
        assert_eq!(summarize(&old, &new2), "Alert triggers changed");
    }

    #[test]
    fn text_is_parsed_either_way_and_a_bad_text_is_said_so() {
        assert_eq!(summarize_text("{\"clusters\":[]}", "clusters: []\n"), NO_VALUE_CHANGE);
        assert_eq!(summarize_text("", "{\"clusters\":[{\"name\":\"x\"}]}"), "Clusters added");
        assert_eq!(summarize_text("{\"a\":1}", "{ nope"), UNPARSED);
    }

    #[test]
    fn the_secret_key_rule() {
        for k in ["password", "Password", "apiKey", "api_key", "zabbixToken", "secret", "Authorization", "auth", "headers", "credentials",
                  "passphrase", "keyPassphrase", "privateKey", "private_key", "sshKey", "ssh_key", "x-api-key", "service_key", "X-Api-Key", "key"] {
            assert!(is_secret_key(k), "{k}");
        }
        for k in ["keyFile", "key_file", "url", "name", "username", "host", "tokens_dir_note", "keys"] {
            // `tokens_dir_note` contains "token": it is treated as secret — better hidden than shown.
            assert_eq!(is_secret_key(k), k == "tokens_dir_note", "{k}");
        }
    }

    #[test]
    fn a_url_with_credentials_never_reaches_a_summary() {
        assert_eq!(redact_url("https://elastic:hunter2@es.example:9200/_cat"), "https://es.example:9200/_cat");
        assert_eq!(redact_url("http://es.example:9200"), "http://es.example:9200");
        assert_eq!(redact_url("elastic:hunter2@es.example:9200"), "es.example:9200");
        assert_eq!(redact_url("user@mail.example"), "mail.example", "an address alone is redacted too: it may carry a login");
        assert!(has_userinfo("http://a:b@h") && !has_userinfo("http://h/x@y"), "an @ in the path is not userinfo");
        // Named by URL only: the address, not the login.
        let old = json!({ "clusters": [{ "url": "http://elastic:pw1@h:9200" }] });
        let new = json!({ "clusters": [{ "url": "http://elastic:pw1@h:9200" }, { "url": "http://elastic:pw2@h2:9200" }] });
        let s = summarize(&old, &new);
        assert_eq!(s, "Clusters · http://h2:9200 added");
        // A scalar with userinfo is "changed", never shown — even under an innocent key.
        let old = json!({ "defaults": { "endpoint": "http://elastic:pw1@h:9200", "note": "ask bob@ops" } });
        let new = json!({ "defaults": { "endpoint": "http://elastic:pw2@h:9200", "note": "ask ann@ops" } });
        let s = summarize(&old, &new);
        assert_eq!(s, "Defaults · endpoint changed; Defaults · note changed");
        for leak in ["pw1", "pw2", "elastic", "bob", "ann"] {
            assert!(!s.contains(leak), "{leak} leaked into {s:?}");
        }
        // A cluster whose only change is its URL credential: the field is named, not the value.
        let old = json!({ "clusters": [{ "name": "c1", "url": "http://e:pw1@h" }] });
        let new = json!({ "clusters": [{ "name": "c1", "url": "http://e:pw2@h" }] });
        assert_eq!(summarize(&old, &new), "Clusters · c1 changed (url)");
    }
}
