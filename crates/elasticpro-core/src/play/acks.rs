//! Shared acknowledgements (docs/PLAY.md "Shared acknowledgements"): `<data>/acks.json`.
//!
//! On the hosted server an acknowledgement is the team's, not one browser's: the person at
//! the desk acknowledges, and the wall stops taking the screen for it. Keyed exactly as
//! `ui/js/core/acks.js` keys them (`<clusterId>:<rule>…`, merged alerts `<cluster>:<rule>`).
//! Desktop keeps IndexedDB; browser acknowledgements are not migrated (they were per person).
//!
//! Each entry is `{by, at, note?, record?}`: who changed it last and when (stamped here, never
//! taken from the page), an optional note, and the page's own record (acks.js `AckRecord`
//! without its key: acked, ackedAt, ackedBy, notes, missingSince, ackedItems). In the record
//! the server stamps what a page could otherwise claim: who acknowledged and when, and who
//! wrote each new note.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const FILE: &str = "acks.json";
pub const MAX_KEYS: usize = 20_000;
pub const MAX_KEY: usize = 512;
pub const MAX_NOTE: usize = 2000;
/// The page's record, serialised, at most.
pub const MAX_RECORD: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ack {
    pub by: String,
    /// ms since the epoch.
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<Value>,
}

impl Ack {
    /// Acknowledged, as opposed to kept only for its notes.
    pub fn acked(&self) -> bool {
        self.record.as_ref().is_none_or(|r| r.get("acked") != Some(&Value::Bool(false)))
    }
}

pub struct Acks {
    path: Option<PathBuf>,
    map: RwLock<BTreeMap<String, Ack>>,
    saving: parking_lot::Mutex<()>,
}

/// The key, checked: non-empty, bounded, no control characters.
pub fn check_key(key: &str) -> Result<&str, String> {
    let k = key.trim();
    if k.is_empty() || k.len() > MAX_KEY || k.chars().any(char::is_control) {
        return Err(format!("key: an alert key of 1 to {MAX_KEY} characters"));
    }
    Ok(k)
}

impl Acks {
    pub fn open(path: Option<PathBuf>) -> Acks {
        let map = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<BTreeMap<String, Ack>>(&s).ok())
            .unwrap_or_default();
        Acks { path, map: RwLock::new(map), saving: Default::default() }
    }

    fn save(&self) -> Result<(), String> {
        let Some(p) = &self.path else { return Ok(()) };
        let _one = self.saving.lock();
        let body = serde_json::to_vec(&*self.map.read()).map_err(|e| e.to_string())?;
        super::write_private(p, &body)
    }

    pub fn list(&self) -> BTreeMap<String, Ack> {
        self.map.read().clone()
    }

    /// Set (or change) the acknowledgement under `key`.
    pub fn set(&self, key: &str, note: Option<&str>, record: Option<&Value>, by: &str, now_ms: u64) -> Result<Ack, String> {
        let key = check_key(key)?;
        let note = note.map(str::trim).filter(|n| !n.is_empty());
        if note.is_some_and(|n| n.len() > MAX_NOTE) {
            return Err(format!("note: at most {MAX_NOTE} characters"));
        }
        let prev = self.map.read().get(key).cloned();
        let record = match record {
            None | Some(Value::Null) => None,
            Some(Value::Object(_)) => Some(stamp(record.cloned().unwrap_or_default(), prev.as_ref(), by, now_ms)),
            Some(_) => return Err("record must be an object".into()),
        };
        if record.as_ref().is_some_and(|r| r.to_string().len() > MAX_RECORD) {
            return Err(format!("record: at most {} KB", MAX_RECORD / 1024));
        }
        if prev.is_none() && self.map.read().len() >= MAX_KEYS {
            return Err(format!("at most {MAX_KEYS} acknowledgements are kept; clear old ones first"));
        }
        let ack = Ack { by: by.to_string(), at: now_ms, note: note.map(String::from), record };
        self.map.write().insert(key.to_string(), ack.clone());
        if let Err(e) = self.save() {
            match prev {
                Some(p) => self.map.write().insert(key.to_string(), p),
                None => self.map.write().remove(key),
            };
            return Err(format!("the acknowledgement could not be saved: {e}"));
        }
        Ok(ack)
    }

    /// Remove the entry under `key`. `Ok(None)` when there was none.
    pub fn clear(&self, key: &str) -> Result<Option<Ack>, String> {
        let key = check_key(key)?;
        let gone = self.map.write().remove(key);
        if let Some(g) = &gone {
            if let Err(e) = self.save() {
                self.map.write().insert(key.to_string(), g.clone());
                return Err(format!("the acknowledgement could not be removed: {e}"));
            }
        }
        Ok(gone)
    }
}

/// The page's record with what only the server can vouch for put in by the server.
///
/// * `ackedBy` / `ackedAt`: the caller and now, when this change acknowledges (it was not
///   acknowledged, or the page acknowledged again); otherwise what was stored. Cleared when
///   the record is not acknowledged.
/// * each note not stored before (by its `ts`) is the caller's.
fn stamp(mut rec: Value, prev: Option<&Ack>, by: &str, now_ms: u64) -> Value {
    let Some(m) = rec.as_object_mut() else { return rec };
    m.remove("key");
    let prev_rec = prev.and_then(|p| p.record.clone());
    let prev_acked = prev.is_some_and(Ack::acked);
    let acked = m.get("acked") != Some(&Value::Bool(false));
    m.insert("acked".into(), json!(acked));
    if acked {
        let prev_at = prev_rec.as_ref().and_then(|r| r.get("ackedAt")).cloned();
        let again = m.get("ackedAt").is_some_and(|a| Some(a) != prev_at.as_ref());
        if !prev_acked || again {
            m.insert("ackedBy".into(), json!(by));
            m.insert("ackedAt".into(), json!(now_ms));
        } else {
            let p = prev_rec.unwrap_or_default();
            m.insert("ackedBy".into(), p.get("ackedBy").cloned().unwrap_or_else(|| json!(prev.map(|a| a.by.clone()).unwrap_or_default())));
            m.insert("ackedAt".into(), p.get("ackedAt").cloned().unwrap_or_else(|| json!(prev.map(|a| a.at).unwrap_or(now_ms))));
        }
    } else {
        m.insert("ackedBy".into(), json!(""));
        m.insert("ackedAt".into(), json!(0));
    }
    let old_ts: Vec<Value> = prev.and_then(|p| p.record.as_ref()).and_then(|r| r.get("notes")).and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|n| n.get("ts").cloned()).collect()).unwrap_or_default();
    if let Some(Value::Array(notes)) = m.get_mut("notes") {
        for n in notes.iter_mut() {
            if let Some(o) = n.as_object_mut() {
                if !o.get("ts").is_some_and(|t| old_ts.contains(t)) {
                    o.insert("by".into(), json!(by));
                }
            }
        }
    }
    rec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_says_who_acknowledged() {
        let a = Acks::open(None);
        let r = a.set("c1:disk", None, Some(&json!({ "acked": true, "ackedAt": 1, "ackedBy": "somebody-else",
            "notes": [{ "text": "on it", "by": "forged", "ts": 7 }] })), "kd", 100).unwrap();
        let rec = r.record.unwrap();
        assert_eq!((rec["ackedBy"].clone(), rec["ackedAt"].clone()), (json!("kd"), json!(100)));
        assert_eq!(rec["notes"][0]["by"], json!("kd"));
        // Another person adds a note: the acknowledgement stays the first person's.
        let r2 = a.set("c1:disk", None, Some(&json!({ "acked": true, "ackedAt": 100, "ackedBy": "kd",
            "notes": [{ "text": "on it", "by": "kd", "ts": 7 }, { "text": "vendor called", "by": "x", "ts": 8 }] })), "ann", 200).unwrap();
        let rec2 = r2.record.unwrap();
        assert_eq!(rec2["ackedBy"], json!("kd"));
        assert_eq!(rec2["notes"][0]["by"], json!("kd"), "an old note keeps its author");
        assert_eq!(rec2["notes"][1]["by"], json!("ann"));
        assert_eq!(r2.by, "ann", "the entry says who changed it last");
        // Un-acknowledged with notes kept.
        let r3 = a.set("c1:disk", None, Some(&json!({ "acked": false, "notes": rec2["notes"] })), "ann", 300).unwrap();
        assert!(!r3.acked());
        assert_eq!(r3.record.unwrap()["ackedBy"], json!(""));
    }

    #[test]
    fn keys_notes_and_records_are_bounded() {
        let a = Acks::open(None);
        assert!(a.set("", None, None, "kd", 1).is_err());
        assert!(a.set(&"k".repeat(MAX_KEY + 1), None, None, "kd", 1).is_err());
        assert!(a.set("c1:x", Some(&"n".repeat(MAX_NOTE + 1)), None, "kd", 1).is_err());
        assert!(a.set("c1:x", None, Some(&json!([1])), "kd", 1).is_err());
        assert!(a.set("c1:x", None, Some(&json!({ "notes": [{ "text": "x".repeat(MAX_RECORD) }] })), "kd", 1).is_err());
        let ok = a.set("c1:x", Some(" seen "), None, "kd", 1).unwrap();
        assert_eq!(ok.note.as_deref(), Some("seen"));
        assert!(ok.acked(), "no record: an acknowledgement");
        assert_eq!(a.clear("c1:x").unwrap().map(|x| x.by), Some("kd".into()));
        assert_eq!(a.clear("c1:x").unwrap(), None);
    }
}
