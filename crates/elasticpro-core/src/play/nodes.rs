//! Node-name history (docs/PLAY.md "Node-name history"): which nodes each cluster had, so a
//! wall can say "a node left" — a fact no single `_cat/nodes` answer holds.
//!
//! Fed from every `nodes` dataset entry the fleet poller completes (`fleet_finish`): the
//! names it already fetched, so not one request more goes to a cluster. Kept 24 h — a name
//! not seen for a day is no longer expected — or, with `nodeExpected: "pinned"`, the pinned
//! list. Persisted to `<data>/play/nodes.json` when what is known changes (a name appears,
//! goes or comes back) and otherwise every few minutes, so a restart keeps what was missing
//! and since when.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const FILE: &str = "nodes.json";
/// How long a name is remembered after it was last seen.
pub const KEEP_MS: u64 = 24 * 3600 * 1000;
/// A last-seen time that moved, and nothing else, is written at most this often.
const PERSIST_EVERY_MS: u64 = 5 * 60_000;
/// Names kept per cluster, at most.
const MAX_NAMES: usize = 2000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClusterNodes {
    /// name -> when it was last in a `nodes` answer (ms).
    seen: BTreeMap<String, u64>,
    /// The names in the last answer.
    present: Vec<String>,
    /// When the last answer came (ms).
    as_of: u64,
    /// name -> when it was first found missing (ms), for every expected name not present.
    gone: BTreeMap<String, u64>,
}

pub struct NodeHistory {
    path: Option<PathBuf>,
    map: Mutex<BTreeMap<String, ClusterNodes>>,
    last_write: Mutex<u64>,
}

/// The names in a `nodes` dataset answer (`{nodes: {ok, json: [{name, …}]}}`), or `None`
/// when the node listing itself did not answer — which says nothing about who left.
pub fn names_in(answer: &serde_json::Map<String, Value>) -> Option<Vec<String>> {
    let nodes = answer.get("nodes")?;
    if nodes.get("ok") != Some(&json!(true)) {
        return None;
    }
    let rows = nodes.get("json")?.as_array()?;
    let mut names: Vec<String> = rows.iter().filter_map(|r| r.get("name").and_then(Value::as_str))
        .map(str::trim).filter(|n| !n.is_empty()).map(String::from).collect();
    names.sort();
    names.dedup();
    Some(names)
}

impl NodeHistory {
    pub fn open(path: Option<PathBuf>) -> NodeHistory {
        let map = path.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<BTreeMap<String, ClusterNodes>>(&s).ok())
            .unwrap_or_default();
        NodeHistory { path, map: Mutex::new(map), last_write: Mutex::new(0) }
    }

    fn write(&self, now_ms: u64) {
        let Some(p) = &self.path else { return };
        let body = match serde_json::to_vec(&*self.map.lock()) {
            Ok(b) => b,
            Err(_) => return,
        };
        *self.last_write.lock() = now_ms;
        if let Err(e) = super::write_private(p, &body) {
            tracing::warn!(error = %e, "Play node history could not be saved; it is still kept in memory");
        }
    }

    /// One completed `nodes` answer for a cluster. `pinned` is the cluster's pinned list
    /// (empty when there is none): pinned names are expected even before they are seen.
    pub fn record(&self, cluster: &str, names: &[String], pinned: &[String], now_ms: u64) {
        let changed = {
            let mut map = self.map.lock();
            let c = map.entry(cluster.to_string()).or_default();
            let before = (c.seen.keys().cloned().collect::<Vec<_>>(), c.present.clone(), c.gone.clone());
            for n in names {
                c.seen.insert(n.clone(), now_ms);
            }
            // A day without it: no longer expected (unless pinned).
            c.seen.retain(|n, at| now_ms.saturating_sub(*at) < KEEP_MS || pinned.contains(n));
            if c.seen.len() > MAX_NAMES {
                let mut by_age: Vec<(String, u64)> = c.seen.iter().map(|(n, a)| (n.clone(), *a)).collect();
                by_age.sort_by_key(|(_, a)| std::cmp::Reverse(*a));
                c.seen = by_age.into_iter().take(MAX_NAMES).collect();
            }
            c.present = names.to_vec();
            c.as_of = now_ms;
            let expected: Vec<&String> = c.seen.keys().chain(pinned.iter()).collect();
            c.gone.retain(|n, _| expected.contains(&n) && !names.contains(n));
            for n in expected {
                if !names.contains(n) {
                    c.gone.entry(n.clone()).or_insert(now_ms);
                }
            }
            before != (c.seen.keys().cloned().collect::<Vec<_>>(), c.present.clone(), c.gone.clone())
        };
        if changed || now_ms.saturating_sub(*self.last_write.lock()) >= PERSIST_EVERY_MS {
            self.write(now_ms);
        }
    }

    /// A node removed on purpose: forgotten, so it is no longer expected. Returns whether
    /// the cluster knew it.
    pub fn forget(&self, cluster: &str, node: &str, now_ms: u64) -> bool {
        let known = {
            let mut map = self.map.lock();
            match map.get_mut(cluster) {
                Some(c) => {
                    let a = c.seen.remove(node).is_some();
                    let b = c.gone.remove(node).is_some();
                    a || b
                }
                None => false,
            }
        };
        if known {
            self.write(now_ms);
        }
        known
    }

    /// What a wall shows for one cluster: `{expected, present, left: [{node, since}], asOf}`,
    /// or `None` before its first `nodes` answer. `pinned`: the expected list when the
    /// setting says so and the cluster has one; otherwise every name seen in 24 h.
    pub fn state(&self, cluster: &str, pinned: Option<&[String]>, now_ms: u64) -> Option<Value> {
        let map = self.map.lock();
        let c = map.get(cluster)?;
        let mut expected: Vec<String> = match pinned.filter(|p| !p.is_empty()) {
            Some(p) => p.to_vec(),
            None => c.seen.iter().filter(|(_, at)| now_ms.saturating_sub(**at) < KEEP_MS).map(|(n, _)| n.clone()).collect(),
        };
        expected.sort();
        expected.dedup();
        let mut left: Vec<(String, u64)> = expected.iter().filter(|n| !c.present.contains(n))
            .map(|n| (n.clone(), c.gone.get(n).copied().unwrap_or(c.as_of))).collect();
        // Newest first: the wall's strip names the newest.
        left.sort_by_key(|(n, since)| (std::cmp::Reverse(*since), n.clone()));
        Some(json!({
            "expected": expected,
            "present": c.present,
            "left": left.into_iter().map(|(node, since)| json!({ "node": node, "since": since })).collect::<Vec<_>>(),
            "asOf": c.as_of,
        }))
    }

    /// Write what has moved since the last write (at shutdown, or from housekeeping).
    pub fn flush(&self, now_ms: u64) {
        self.write(now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_name_missing_from_the_next_answer_has_left() {
        let h = NodeHistory::open(None);
        h.record("c1", &names(&["a", "b"]), &[], 1000);
        assert_eq!(h.state("c1", None, 1000).unwrap()["left"], json!([]));
        h.record("c1", &names(&["a"]), &[], 2000);
        let s = h.state("c1", None, 2000).unwrap();
        assert_eq!(s["left"], json!([{ "node": "b", "since": 2000 }]));
        assert_eq!(s["expected"], json!(["a", "b"]));
        // Still missing later: since does not move.
        h.record("c1", &names(&["a"]), &[], 3000);
        assert_eq!(h.state("c1", None, 3000).unwrap()["left"][0]["since"], json!(2000));
        // Back: no longer left.
        h.record("c1", &names(&["a", "b"]), &[], 4000);
        assert_eq!(h.state("c1", None, 4000).unwrap()["left"], json!([]));
        assert!(h.state("other", None, 4000).is_none(), "never answered: nothing known, not 'none left'");
    }

    #[test]
    fn a_day_without_it_and_forget_both_end_it() {
        let h = NodeHistory::open(None);
        h.record("c1", &names(&["a", "b"]), &[], 0);
        h.record("c1", &names(&["a"]), &[], 1000);
        assert_eq!(h.state("c1", None, 1000).unwrap()["left"].as_array().unwrap().len(), 1);
        assert!(h.forget("c1", "b", 2000));
        assert_eq!(h.state("c1", None, 2000).unwrap()["left"], json!([]));
        assert!(!h.forget("c1", "b", 2000), "already forgotten");
        h.record("c1", &names(&["a", "c"]), &[], 3000);
        h.record("c1", &names(&["a"]), &[], KEEP_MS + 3000);
        assert_eq!(h.state("c1", None, KEEP_MS + 3000).unwrap()["left"], json!([]), "c was last seen a day ago");
    }

    #[test]
    fn pinned_names_are_expected_before_they_are_seen() {
        let h = NodeHistory::open(None);
        let pinned = names(&["a", "b", "z"]);
        h.record("c1", &names(&["a", "b"]), &pinned, 10);
        let s = h.state("c1", Some(&pinned), 10).unwrap();
        assert_eq!(s["left"], json!([{ "node": "z", "since": 10 }]));
    }

    #[test]
    fn names_come_from_the_node_listing_only_when_it_answered() {
        let ok = json!({ "nodes": { "ok": true, "json": [{ "name": "n2" }, { "name": "n1" }, { "ip": "x" }] }, "alloc": {} });
        assert_eq!(names_in(ok.as_object().unwrap()), Some(names(&["n1", "n2"])));
        let failed = json!({ "nodes": { "ok": false, "status": 500 } });
        assert_eq!(names_in(failed.as_object().unwrap()), None);
    }
}
