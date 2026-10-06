//! Optional: remember the Elasticsearch credential in the OS vault (Windows Credential
//! Manager / macOS Keychain / Secret Service). Off unless the operator ticks the box in
//! the credential dialog. Stored as the finished Authorization header value under one
//! entry per config file, so nothing has to be re-derived.

use serde_json::{json, Value};

const SERVICE: &str = "ElasticPro";

fn entry(scope: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, scope).map_err(|e| e.to_string())
}

pub fn handle(t: &str, msg: &Value) -> Value {
    let scope = msg.get("scope").and_then(|v| v.as_str()).unwrap_or("default");
    match t {
        "VAULT_GET" => match entry(scope).and_then(|e| e.get_password().map_err(|e| e.to_string())) {
            Ok(v) => json!({ "ok": true, "found": true, "value": v }),
            Err(e) if e.to_lowercase().contains("no matching") || e.to_lowercase().contains("not found") => {
                json!({ "ok": true, "found": false })
            }
            Err(e) => json!({ "ok": false, "message": e }),
        },
        "VAULT_SET" => {
            let value = msg.get("value").and_then(|v| v.as_str()).unwrap_or("");
            match entry(scope).and_then(|e| e.set_password(value).map_err(|e| e.to_string())) {
                Ok(_) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "message": e }),
            }
        }
        "VAULT_DEL" => match entry(scope).and_then(|e| e.delete_credential().map_err(|e| e.to_string())) {
            Ok(_) => json!({ "ok": true }),
            Err(e) if e.to_lowercase().contains("no matching") || e.to_lowercase().contains("not found") => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "message": e }),
        },
        _ => json!({ "ok": false }),
    }
}
