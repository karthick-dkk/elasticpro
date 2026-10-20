//! Our requests as Elasticsearch sees them: the task list, our opaque id in it, and which
//! of our tasks the core may cancel by itself.
//!
//! Every request the core sends carries `X-Opaque-Id: elasticpro/<instance>/<origin>/
//! <cluster>/<record>` (see `bridge::opaque_id`). Elasticsearch keeps that header on the
//! task, so `GET _tasks?detailed` tells our searches from a Kibana report or somebody's
//! curl — and tells which of ours nobody is waiting for any more: a page that was left, a
//! client that went away, a request that timed out here while the cluster kept going.
//!
//! The reaper cancels exactly those, and nothing else:
//!
//! * the id is ours — this run's instance, or the run before (persisted, so a restart does
//!   not leave the last run's searches running unseen);
//! * the action only reads (search, cat/monitor, snapshot status) — never a reindex, a
//!   delete-by-query or anything else that writes, whoever started it;
//! * it is not a child task (cancelling the parent takes its children with it);
//! * for this run, its record number is not in flight here — something still waiting on a
//!   task is never cut off (`overdue` mode adds: or it has run past ES_TASK_MAX_SECONDS).
//!
//! `TASKS_PATH` and `OPAQUE_PREFIX` are defined here once; the Request Centre's Tasks panel
//! reads both from the REQUEST_LOG reply instead of keeping its own copy.

use crate::gate::ReaperMode;
use serde_json::Value;
use std::collections::HashSet;

/// The task listing the reaper and the Tasks panel both read.
pub const TASKS_PATH: &str = "/_tasks?actions=*search*,*cat*,*snapshot/status*&detailed&group_by=none";
/// What every opaque id of ours starts with.
pub const OPAQUE_PREFIX: &str = "elasticpro/";

/// `elasticpro/<instance>/<origin>/<cluster>/<n>`, parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opaque {
    pub instance: String,
    pub origin: String,
    pub cluster: String,
    pub n: u64,
}

pub fn parse_opaque(id: &str) -> Option<Opaque> {
    let rest = id.strip_prefix(OPAQUE_PREFIX)?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 4 {
        return None;
    }
    Some(Opaque { instance: parts[0].into(), origin: parts[1].into(), cluster: parts[2].into(), n: parts[3].parse().ok()? })
}

/// How a cluster id appears inside an opaque id (`bridge::opaque_id` cleans it the same way).
pub fn clean(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.:".contains(c) { c } else { '_' }).take(64).collect()
}

/// An action that only reads. Anything else — above all `indices:data/write/*`, which is
/// where reindex, update-by-query and delete-by-query live — is never ours to cancel.
pub fn is_read_action(action: &str) -> bool {
    action.starts_with("indices:data/read/")
        || action.starts_with("indices:monitor/")
        || action.starts_with("cluster:monitor/")
        || action == "cluster:admin/snapshot/status"
        || action == "cluster:admin/snapshot/get"
}

/// A task id as Elasticsearch writes it: `<node id>:<number>`. Anything else is not
/// something the reaper will put in a path.
pub fn is_task_id(id: &str) -> bool {
    match id.split_once(':') {
        Some((node, n)) => !node.is_empty() && node.len() <= 64
            && node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !n.is_empty() && n.len() <= 20 && n.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// One task the reaper decided to cancel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub task_id: String,
    pub opaque: String,
    pub action: String,
    pub running_ms: Option<u64>,
    pub n: u64,
    /// This run's (false: the run before's).
    pub current: bool,
}

/// What the reaper knows when it reads one cluster's task list.
pub struct Scope<'a> {
    pub cluster: &'a str,
    pub instance: &'a str,
    pub previous: Option<&'a str>,
    /// Record numbers of this run's requests still in flight.
    pub inflight: &'a HashSet<u64>,
    pub mode: ReaperMode,
    pub max_ms: u64,
}

fn opaque_of(t: &Value) -> Option<String> {
    let h = t.get("headers")?.as_object()?;
    let v = h.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-opaque-id"))?.1;
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => a.first().and_then(Value::as_str).map(String::from),
        _ => None,
    }
}

/// Every task in either answer shape (`group_by=none`'s list, or the default node tree).
fn all_tasks(res: &Value) -> Vec<(String, &Value)> {
    let mut out = Vec::new();
    if let Some(a) = res.get("tasks").and_then(Value::as_array) {
        for t in a {
            let id = match (t.get("node").and_then(Value::as_str), t.get("id").and_then(Value::as_u64)) {
                (Some(n), Some(i)) => format!("{n}:{i}"),
                _ => continue,
            };
            out.push((id, t));
        }
    }
    if let Some(nodes) = res.get("nodes").and_then(Value::as_object) {
        for node in nodes.values() {
            if let Some(ts) = node.get("tasks").and_then(Value::as_object) {
                out.extend(ts.iter().map(|(id, t)| (id.clone(), t)));
            }
        }
    }
    out
}

/// The tasks in this listing the reaper may cancel. Pure: everything it needs is passed in.
pub fn choose(res: &Value, s: &Scope<'_>) -> Vec<Pick> {
    if s.mode == ReaperMode::Off {
        return vec![];
    }
    let mut out = Vec::new();
    for (task_id, t) in all_tasks(res) {
        let Some(opaque) = opaque_of(t) else { continue };
        let Some(o) = parse_opaque(&opaque) else { continue };
        let current = o.instance == s.instance;
        if !(current || s.previous.is_some_and(|p| p == o.instance)) || o.cluster != clean(s.cluster) {
            continue;
        }
        let action = t.get("action").and_then(Value::as_str).unwrap_or("");
        if !is_read_action(action) || !is_task_id(&task_id) {
            continue;
        }
        if t.get("parent_task_id").is_some_and(|p| !p.is_null()) || t.get("cancellable") == Some(&Value::Bool(false)) || t.get("cancelled") == Some(&Value::Bool(true)) {
            continue;
        }
        let running_ms = t.get("running_time_in_nanos").and_then(Value::as_u64).map(|n| n / 1_000_000);
        let orphan = !current || !s.inflight.contains(&o.n);
        let overdue = s.mode == ReaperMode::Overdue && running_ms.is_some_and(|ms| ms > s.max_ms);
        if orphan || overdue {
            out.push(Pick { task_id, opaque, action: action.to_string(), running_ms, n: o.n, current });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task(id: u64, action: &str, opaque: &str, secs: u64) -> Value {
        json!({ "node": "nodeA", "id": id, "action": action, "running_time_in_nanos": secs * 1_000_000_000u64,
                "cancellable": true, "headers": { "X-Opaque-Id": opaque } })
    }

    #[test]
    fn only_our_orphaned_read_tasks_are_chosen() {
        let res = json!({ "tasks": [
            task(1, "indices:data/read/search", "elasticpro/abcd/page:logs/es1/10", 5),          // ours, orphan
            task(2, "indices:data/read/search", "elasticpro/abcd/page:logs/es1/11", 5),          // ours, still in flight
            task(3, "indices:data/write/reindex", "elasticpro/abcd/console/es1/12", 900),        // ours, but a write
            task(4, "indices:data/read/search", "kibana-report-1", 900),                          // not ours
            task(5, "indices:data/read/search", "elasticpro/zzzz/page:logs/es1/13", 900),        // another install
            task(6, "indices:data/read/search", "elasticpro/prev/poller:health/es1/2", 5),       // the run before's
            task(7, "indices:monitor/stats", "elasticpro/abcd/page:indices/other/14", 5),        // ours, other cluster
            task(8, "cluster:admin/snapshot/status", "elasticpro/abcd/page:snapshots/es1/15", 5),
            task(9, "indices:data/write/delete/byquery", "elasticpro/prev/console/es1/3", 900),  // the run before's write
        ] });
        let inflight: HashSet<u64> = [11].into();
        let s = Scope { cluster: "es1", instance: "abcd", previous: Some("prev"), inflight: &inflight, mode: ReaperMode::Orphans, max_ms: 300_000 };
        let picked: Vec<String> = choose(&res, &s).into_iter().map(|p| p.task_id).collect();
        assert_eq!(picked, vec!["nodeA:1", "nodeA:6", "nodeA:8"]);
        let s = Scope { mode: ReaperMode::Off, ..s };
        assert!(choose(&res, &s).is_empty());
    }

    #[test]
    fn overdue_adds_long_runners_still_in_flight_and_children_are_left_to_their_parent() {
        let mut child = task(2, "indices:data/read/search[phase/query]", "elasticpro/abcd/page:logs/es1/20", 400);
        child["parent_task_id"] = json!("nodeA:1");
        let res = json!({ "nodes": { "nodeA": { "tasks": {
            "nodeA:1": task(1, "indices:data/read/search", "elasticpro/abcd/page:logs/es1/20", 400),
            "nodeA:2": child,
        } } } });
        let inflight: HashSet<u64> = [20].into();
        let s = Scope { cluster: "es1", instance: "abcd", previous: None, inflight: &inflight, mode: ReaperMode::Orphans, max_ms: 300_000 };
        assert!(choose(&res, &s).is_empty(), "in flight: not an orphan");
        let s = Scope { mode: ReaperMode::Overdue, ..s };
        let p = choose(&res, &s);
        assert_eq!(p.iter().map(|p| p.task_id.as_str()).collect::<Vec<_>>(), vec!["nodeA:1"], "the parent only");
        assert_eq!(p[0].running_ms, Some(400_000));
    }

    #[test]
    fn ids_and_actions() {
        assert!(is_task_id("oTUltX4IQMOUUVeiohTt8A:12345"));
        assert!(!is_task_id("node:12/../_bulk") && !is_task_id(":1") && !is_task_id("n:") && !is_task_id("n:1x") && !is_task_id("n 1:2"));
        assert!(is_read_action("indices:data/read/search") && is_read_action("cluster:monitor/state"));
        assert!(!is_read_action("indices:data/write/reindex") && !is_read_action("cluster:admin/snapshot/create"));
        assert_eq!(parse_opaque("elasticpro/ab/console/c1/3"), Some(Opaque { instance: "ab".into(), origin: "console".into(), cluster: "c1".into(), n: 3 }));
        assert_eq!(parse_opaque("elasticpro/ab/console/c1"), None);
        assert_eq!(clean("prod cluster/1"), "prod_cluster_1");
    }
}
