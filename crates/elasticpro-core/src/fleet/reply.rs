//! A reply that carries cached bodies as the text they are held as.
//!
//! `FLEET_STATE` and `CLUSTER_DATASET` hand back cached bodies. Built as a
//! `serde_json::Value`, every body in the reply was parsed into one first — for a full
//! `FLEET_STATE` that is the whole background set of every cluster at several times its
//! JSON size, per tab, and every tab asks for exactly that the moment a restarted core is
//! back (its epoch changed). A `Reply` instead holds the envelope as a `Value` with a
//! marker where each body goes, plus the bodies themselves (`Arc`s, taken under the fleet
//! lock without copying), and the hosted bridge writes it out with the bodies spliced in
//! as text: the most it ever costs is the reply's own JSON.
//!
//! `into_value` parses the bodies back in, for the desktop shell and the tests, which want
//! a `Value` and are never asked for a fleet's worth at once. Both produce the same JSON.

use super::entry::{Body, Entry};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Value;
use std::sync::OnceLock;

/// Starts every marker. With a NUL and a per-process nonce, nothing Elasticsearch or a
/// person sent can be mistaken for one — and only the envelope is searched, never a body.
const MARK: &str = "\u{0}ep-body:";

fn nonce() -> &'static str {
    static N: OnceLock<String> = OnceLock::new();
    N.get_or_init(|| crate::auth::random_hex(8))
}

#[derive(Debug, Default)]
pub struct Reply {
    pub value: Value,
    bodies: Vec<Body>,
}

impl From<Value> for Reply {
    fn from(value: Value) -> Reply {
        Reply { value, bodies: vec![] }
    }
}

impl Reply {
    /// A marker for `b`, to put where the body goes.
    pub fn body(&mut self, b: &Body) -> Value {
        self.bodies.push(b.clone());
        Value::String(format!("{MARK}{}:{}", nonce(), self.bodies.len() - 1))
    }

    /// An entry as the wire shows it, with its body as a marker.
    pub fn entry(&mut self, e: &Entry) -> Value {
        let mut v = serde_json::to_value(Entry { data: None, ..e.clone() }).unwrap_or(Value::Null);
        if let (Some(b), Some(m)) = (&e.data, v.as_object_mut()) {
            m.insert("data".into(), self.body(b));
        }
        v
    }

    pub fn has_bodies(&self) -> bool {
        !self.bodies.is_empty()
    }

    fn index_of(&self, s: &str) -> Option<usize> {
        let i: usize = s.strip_prefix(MARK)?.strip_prefix(nonce())?.strip_prefix(':')?.parse().ok()?;
        (i < self.bodies.len()).then_some(i)
    }

    /// The reply as one `Value`, bodies parsed in.
    pub fn into_value(mut self) -> Value {
        fn walk(v: &mut Value, r: &Reply) {
            match v {
                Value::String(s) => {
                    if let Some(i) = r.index_of(s) {
                        *v = r.bodies[i].parse();
                    }
                }
                Value::Array(a) => a.iter_mut().for_each(|x| walk(x, r)),
                Value::Object(m) => m.values_mut().for_each(|x| walk(x, r)),
                _ => {}
            }
        }
        let mut v = std::mem::take(&mut self.value);
        if self.has_bodies() {
            walk(&mut v, &self);
        }
        v
    }

    /// The reply as JSON text, bodies spliced in as they are held.
    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(&Spliced { v: &self.value, r: self }).unwrap_or_else(|_| b"null".to_vec())
    }
}

struct Spliced<'a> {
    v: &'a Value,
    r: &'a Reply,
}

impl Serialize for Spliced<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.v {
            Value::String(t) => match self.r.index_of(t) {
                Some(i) => self.r.bodies[i].serialize(s),
                None => s.serialize_str(t),
            },
            Value::Array(a) => {
                let mut seq = s.serialize_seq(Some(a.len()))?;
                for x in a {
                    seq.serialize_element(&Spliced { v: x, r: self.r })?;
                }
                seq.end()
            }
            Value::Object(m) => {
                let mut map = s.serialize_map(Some(m.len()))?;
                for (k, x) in m {
                    map.serialize_entry(k, &Spliced { v: x, r: self.r })?;
                }
                map.end()
            }
            other => other.serialize(s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::entry::Status;
    use serde_json::json;

    #[test]
    fn spliced_text_and_parsed_value_say_the_same_thing() {
        let mut e = Entry::never(5, Some(9));
        e.status = Status::Ok;
        e.fetched_at = Some(100);
        e.data = Some(Body::from_value(&json!({ "indices": { "ok": true, "json": [{ "index": "a" }, { "index": "b" }] } })));
        let mut r = Reply::default();
        let entry = r.entry(&e);
        r.value = json!({ "ok": true, "entry": entry, "note": "plain text stays text" });
        let text: Value = serde_json::from_slice(&r.to_json()).unwrap();
        let want = json!({ "ok": true, "note": "plain text stays text", "entry": serde_json::to_value(&e).unwrap() });
        assert_eq!(text, want);
        assert_eq!(text["entry"]["data"]["indices"]["json"][1]["index"], json!("b"));
        assert_eq!(r.into_value(), want);
    }

    #[test]
    fn a_marker_from_somewhere_else_is_only_a_string() {
        let mut r = Reply::default();
        let b = Body::from_value(&json!([1, 2]));
        let m = r.body(&b);
        // A forged marker: wrong nonce, or an index past the end.
        let forged = format!("{MARK}0000000000000000:0");
        let past = format!("{MARK}{}:7", nonce());
        r.value = json!({ "real": m, "forged": forged, "past": past });
        let v: Value = serde_json::from_slice(&r.to_json()).unwrap();
        assert_eq!(v["real"], json!([1, 2]));
        assert_eq!(v["forged"], json!(forged));
        assert_eq!(v["past"], json!(past));
    }

    #[test]
    fn an_entry_without_a_body_says_null() {
        let mut r = Reply::default();
        let v = r.entry(&Entry::never(1, None));
        assert!(!r.has_bodies());
        assert_eq!(v["data"], Value::Null);
        assert_eq!(v["status"], json!("never"));
    }
}
