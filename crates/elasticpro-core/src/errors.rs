//! Error codes: one per kind of failure the core reports, so a screenshot, a log line and
//! a support ticket can name the same thing.
//!
//! Every refusal the bridge returns already carries a `kind`. This is the one table that
//! turns a kind into a code. `stamp()` adds that code to the reply as `errorCode` (not `code`,
//! which a pairing reply already uses for its pairing code), and appends
//! it to `message`, on the way out of the bridge, in one place, so no handler can forget
//! it. The UI shows the message as it arrives; the code is in it.
//!
//! The codes are grouped by what went wrong, not by where:
//! - 1xx: signing in and sessions
//! - 2xx: the request itself
//! - 3xx: config, storage and secrets on the server
//! - 4xx: reaching a cluster
//! - 5xx: Zabbix
//!
//! A code, once given out, keeps its meaning. A new kind gets a new code; it never reuses
//! a retired one.

use serde_json::Value;

/// (kind, code). Several kinds that say the same thing share a code.
const TABLE: &[(&str, &str)] = &[
    // 1xx: signing in and sessions
    ("unauthenticated", "EP-101"),
    ("bad_credentials", "EP-102"),
    ("must_change_password", "EP-103"),
    ("needs_bootstrap", "EP-104"),
    ("disabled", "EP-105"),
    ("locked", "EP-106"),
    ("rate_limited", "EP-107"),
    ("forbidden", "EP-110"),
    ("no_token", "EP-111"),
    ("session_expired", "EP-112"),
    // 2xx: the request
    ("bad_request", "EP-201"),
    ("bad_message", "EP-202"),
    ("malformed", "EP-203"),
    ("bad_method", "EP-204"),
    ("unsupported", "EP-205"),
    ("not_supported", "EP-205"),
    ("not_found", "EP-206"),
    ("name_taken", "EP-207"),
    ("aborted", "EP-208"),
    ("blocked_readonly", "EP-209"),
    // 3xx: config, storage and secrets
    ("no_config", "EP-301"),
    ("parse_error", "EP-302"),
    ("io_error", "EP-303"),
    ("io", "EP-303"),
    ("bad_master", "EP-304"),
    ("no_creds", "EP-305"),
    ("not_configured", "EP-306"),
    ("fleet_off", "EP-307"),
    // 4xx: reaching a cluster
    ("timeout", "EP-401"),
    ("tls_untrusted", "EP-402"),
    ("tls_pin_mismatch", "EP-403"),
    ("tls_error", "EP-404"),
    ("connection_refused", "EP-405"),
    ("dns", "EP-406"),
    ("unreachable", "EP-407"),
    ("connection_reset", "EP-408"),
    ("network", "EP-409"),
    ("tunnel_error", "EP-410"),
    ("hostkey_unknown", "EP-411"),
    ("hostkey_mismatch", "EP-412"),
    ("http_error", "EP-413"),
    ("client_error", "EP-414"),
    // 5xx: Zabbix
    ("zabbix_error", "EP-501"),
    ("not_zabbix", "EP-502"),
    ("bad_signature", "EP-510"),
    ("stale", "EP-511"),
    ("replayed", "EP-512"),
    ("no_role", "EP-513"),
];

/// Anything the table does not name yet.
pub const UNKNOWN: &str = "EP-999";

/// The code for a kind; `EP-999` for one the table does not know.
pub fn code_for(kind: &str) -> &'static str {
    TABLE.iter().find(|(k, _)| *k == kind).map(|(_, c)| *c).unwrap_or(UNKNOWN)
}

/// Give a failed reply its code: `errorCode`, and the same code at the end of `message`.
///
/// Only a reply that says `"ok": false` is touched. A reply that already has a code keeps
/// it; a message that already ends with its code is not given a second one.
pub fn stamp(reply: &mut Value) {
    let Some(m) = reply.as_object_mut() else { return };
    if m.get("ok").and_then(Value::as_bool) != Some(false) {
        return;
    }
    let code = match m.get("errorCode").and_then(Value::as_str) {
        Some(c) => c.to_string(),
        None => {
            let c = code_for(m.get("kind").and_then(Value::as_str).unwrap_or("unknown")).to_string();
            m.insert("errorCode".into(), Value::String(c.clone()));
            c
        }
    };
    let tag = format!("({code})");
    let msg = m.get("message").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !msg.ends_with(&tag) {
        let text = if msg.is_empty() { format!("failed {tag}") } else { format!("{msg} {tag}") };
        m.insert("message".into(), Value::String(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_refusal_gets_its_code_in_the_message() {
        let mut v = json!({ "ok": false, "kind": "bad_credentials", "message": "wrong name or password" });
        stamp(&mut v);
        assert_eq!(v["errorCode"], "EP-102");
        assert_eq!(v["message"], "wrong name or password (EP-102)");
    }

    #[test]
    fn success_is_left_alone_and_stamping_twice_is_once() {
        let mut ok = json!({ "ok": true, "message": "done" });
        stamp(&mut ok);
        assert_eq!(ok, json!({ "ok": true, "message": "done" }));
        let mut v = json!({ "ok": false, "kind": "timeout", "message": "Request timed out" });
        stamp(&mut v);
        stamp(&mut v);
        assert_eq!(v["message"], "Request timed out (EP-401)");
    }

    #[test]
    fn an_unknown_kind_or_no_message_still_says_something() {
        let mut v = json!({ "ok": false, "kind": "never_heard_of_it" });
        stamp(&mut v);
        assert_eq!(v["errorCode"], UNKNOWN);
        assert_eq!(v["message"], "failed (EP-999)");
    }

    #[test]
    fn every_code_and_kind_is_in_the_documentation() {
        let doc = include_str!("../../../docs/ERROR-CODES.md");
        for (k, c) in TABLE {
            assert!(doc.contains(&format!("| {c} |")), "{c} is not in docs/ERROR-CODES.md");
            assert!(doc.contains(&format!("`{k}`")), "{k} is not in docs/ERROR-CODES.md");
        }
    }

    #[test]
    fn every_code_is_well_formed_and_a_kind_is_listed_once() {
        let mut kinds = std::collections::HashSet::new();
        for (k, c) in TABLE {
            assert!(kinds.insert(*k), "{k} is listed twice");
            assert!(c.len() == 6 && c.starts_with("EP-") && c[3..].chars().all(|d| d.is_ascii_digit()), "{c}");
        }
    }
}
