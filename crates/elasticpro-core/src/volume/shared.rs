//! Shared reads (docs/VOLUME.md "Shared reads"): the daily volume collection and the hosts
//! collection of one cluster ask it two identical things — the log indices (`_cat/indices` over
//! the cluster's volume pattern, `collect::cat_request`) and their field mapping (`_field_caps`)
//! — and by default both run from 06:00, each cluster at the same place of its window. What one
//! read, the other uses instead of asking again.
//!
//! What is shared, exactly:
//!
//! * **The index list**, by the request's path: the two build it with the same function from the
//!   same settings, so the same path is the same question. The daily volume run reads it fresh
//!   every time — its sizes are figures it keeps — and leaves it here; the hosts collection uses
//!   it for which indices count on which day (and to split its pages), never for a figure.
//! * **The field mapping**: the daily volume run asks the hosts collection's field list (its own
//!   rows' fields plus the hosts metadata fields, `report::hosts::field_caps_path`) when the
//!   hosts collection is on for the cluster, so one answer serves both. `_field_caps` answers each
//!   field on its own, so the volume rows resolve exactly as from their own, shorter, question.
//!
//! When it is shared — every rule must hold, or the reader asks the cluster itself:
//!
//! * the same cluster and the same path;
//! * read within `SHARE_MS` and on the same UTC day (index names carry UTC dates);
//! * no index of the pattern is split by time (`Listing::time_split`): a rollover between the two
//!   reads would add a write index the older list does not hold — so a listing with any is never
//!   kept, and neither is a mapping asked with the time field.
//!
//! Not shared: the heavy searches. The volume day search (a `terms` top-N per field with sums)
//! and the hosts pages (an exact `composite` of index × host with metadata) are different
//! questions with different answers — terms counts are approximate across shards, a composite's
//! are exact — so neither can be computed from the other without changing a figure.
//!
//! Bounded: one answer per cluster and path, none larger than `MAX_ONE` bytes, `MAX_BYTES` in
//! all (oldest out first), each gone after `SHARE_MS`. In memory: a restart shares nothing until
//! the next read.

use chrono::NaiveDate;
use serde_json::Value;
use std::collections::HashMap;

/// How long a read is shared.
pub const SHARE_MS: u64 = 2 * 3_600_000;
/// The largest answer kept, and all of them together, as JSON text.
pub const MAX_ONE: usize = 4 << 20;
pub const MAX_BYTES: usize = 32 << 20;

struct Read {
    at: u64,
    /// Where the cluster was when it was read (address and route): an answer from before the
    /// cluster moved is another cluster's, never used.
    dest: String,
    day: NaiveDate,
    text: String,
}

/// The answers kept for the other collection (module docs).
#[derive(Default)]
pub struct SharedReads {
    m: parking_lot::Mutex<HashMap<(String, String), Read>>,
}

fn utc_day(ms: u64) -> NaiveDate {
    crate::volume::schedule::utc_day(ms as i64)
}

impl SharedReads {
    /// Keep `json`, the answer to `path` on `cluster` (at `dest`, `Core::shared_dest`) read at `now`.
    pub fn put(&self, cluster: &str, dest: &str, path: &str, json: &Value, now: u64) {
        let text = json.to_string();
        let mut m = self.m.lock();
        m.retain(|_, r| now.saturating_sub(r.at) <= SHARE_MS);
        let key = (cluster.to_string(), path.to_string());
        if text.len() > MAX_ONE {
            m.remove(&key);
            return;
        }
        m.insert(key, Read { at: now, dest: dest.to_string(), day: utc_day(now), text });
        while m.values().map(|r| r.text.len()).sum::<usize>() > MAX_BYTES {
            let Some(oldest) = m.iter().min_by_key(|(_, r)| r.at).map(|(k, _)| k.clone()) else { break };
            m.remove(&oldest);
        }
    }

    /// The answer to `path` on `cluster`, when one is kept that may be used at `now` — read at
    /// the same `dest` (a cluster whose address or route changed since is asked again).
    pub fn get(&self, cluster: &str, dest: &str, path: &str, now: u64) -> Option<Value> {
        let m = self.m.lock();
        let r = m.get(&(cluster.to_string(), path.to_string()))?;
        if r.dest != dest || now < r.at || now - r.at > SHARE_MS || utc_day(now) != r.day {
            return None;
        }
        serde_json::from_str(&r.text).ok()
    }

    /// How old the kept answer is, in ms (for the log line that says one was used).
    pub fn age_ms(&self, cluster: &str, path: &str, now: u64) -> Option<u64> {
        self.m.lock().get(&(cluster.to_string(), path.to_string())).map(|r| now.saturating_sub(r.at))
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.m.lock().values().map(|r| r.text.len()).sum()
    }
}

/// Whether a listing may be shared: no index of it is split by time (module docs).
pub fn listing_shareable(l: &crate::volume::collect::Listing) -> bool {
    l.time_split.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::collect::{self, Indices};
    use crate::volume::VolumeSettings;
    use serde_json::json;

    /// 2026-11-21 00:30 UTC.
    const T: u64 = 1_795_221_000_000;

    #[test]
    fn kept_for_two_hours_of_the_same_utc_day_and_bounded() {
        let s = SharedReads::default();
        let rows = json!([{ "index": "logstash-2026.11.20", "status": "open", "docs.count": "5" }]);
        s.put("a", "d", "/_cat/indices/x", &rows, T);
        assert_eq!(s.get("a", "d", "/_cat/indices/x", T + 60_000), Some(rows.clone()), "the same answer, as it was read");
        assert_eq!(s.get("b", "d", "/_cat/indices/x", T), None, "another cluster's is not this one's");
        assert_eq!(s.get("a", "d", "/_cat/indices/y", T), None, "another question is not this one");
        assert_eq!(s.get("a", "d", "/_cat/indices/x", T + SHARE_MS + 1), None, "past two hours: asked again");
        assert_eq!(s.age_ms("a", "/_cat/indices/x", T + 5_000), Some(5_000));
        assert_eq!(s.get("a", "elsewhere", "/_cat/indices/x", T + 5_000), None, "the cluster moved: asked again");
        // Read at 23:30 UTC, asked for at 00:10: a new UTC day — a new index — asked again.
        let late = T - 3_600_000;
        s.put("a", "d", "/p", &rows, late);
        assert_eq!(s.get("a", "d", "/p", late + 40 * 60_000), None);
        // Too big for one, and the whole bound.
        let big = Value::String("x".repeat(MAX_ONE + 1));
        s.put("a", "d", "/big", &big, T);
        assert_eq!(s.get("a", "d", "/big", T), None);
        let chunk = Value::String("y".repeat(MAX_ONE - 10));
        for i in 0..12 {
            s.put("c", "d", &format!("/c{i}"), &chunk, T + i);
        }
        assert!(s.bytes() <= MAX_BYTES, "{}", s.bytes());
        assert_eq!(s.get("c", "d", "/c0", T + 20), None, "the oldest went first");
        assert!(s.get("c", "d", "/c11", T + 20).is_some());
    }

    #[test]
    fn the_two_collections_ask_the_same_index_list_and_a_split_one_is_never_kept() {
        let vs = VolumeSettings::default();
        let ind = Indices::from_settings(&vs).unwrap();
        // One function builds it for both: the daily volume run and the hosts collection.
        assert_eq!(collect::cat_request("c1", &ind).path, collect::cat_request("c1", &ind).path);
        let dated = json!([{ "index": "logstash-app-2026.11.20", "status": "open", "docs.count": "5", "pri.store.size": "10", "store.size": "20" }]);
        assert!(listing_shareable(&collect::read_cat(&dated, &ind)));
    }

    #[test]
    fn the_volume_rows_resolve_the_same_from_the_hosts_wider_mapping() {
        let vs = VolumeSettings::default();
        let ind = Indices::from_settings(&vs).unwrap();
        let fields = vec!["ClientID".to_string(), "branch".to_string()];
        // The wider question holds every name the volume rows ask, and the metadata fields too.
        let wide = crate::report::hosts::field_caps_path(&ind, &vs, &fields, false);
        for n in collect::field_caps_fields(&vs, false) {
            assert!(wide.contains(&n), "{n} is asked by the wider question too");
        }
        assert!(wide.contains("ClientID.keyword"));
        assert_eq!(crate::report::hosts::field_caps_request("c1", &ind, &vs, &fields, false, 1_000).path, wide, "what the hosts collection sends");
        // `_field_caps` answers each field on its own: the extra ones change no row.
        let own = json!({ "indices": ["i"], "fields": {
            "src_hostname": { "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } },
            "event_logsize": { "long": { "type": "long", "searchable": true, "aggregatable": true } } } });
        let mut wider = own.clone();
        wider["fields"]["ClientID"] = json!({ "keyword": { "type": "keyword", "searchable": true, "aggregatable": true } });
        wider["fields"]["branch"] = json!({ "text": { "type": "text", "searchable": true, "aggregatable": false } });
        let a: Vec<_> = collect::resolve_rows(&own, &vs).into_iter().map(|r| (r.key, r.resolved, r.note)).collect();
        let b: Vec<_> = collect::resolve_rows(&wider, &vs).into_iter().map(|r| (r.key, r.resolved, r.note)).collect();
        assert_eq!(a, b);
    }
}
