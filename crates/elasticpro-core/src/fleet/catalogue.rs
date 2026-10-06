//! The datasets the poller keeps, and the exact requests each one is made of.
//!
//! The paths are the ones `ui/js/core/es.js` built when every page asked Elasticsearch
//! itself, character for character, so the bodies the UI now gets from the cache are the
//! bodies it used to get from the cluster and `buildClusterData` computes every figure
//! exactly as before. One place computes figures; this file only decides what is asked.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Whether the poller keeps a dataset for every cluster, or only while somebody looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    Background,
    OnDemand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dataset {
    Health,
    Nodes,
    IlmErrors,
    Policies,
    IlmAssign,
    Snapshots,
    SnapshotsFull,
    Indices,
    Shards,
}

pub const ALL: [Dataset; 9] = [
    Dataset::Health, Dataset::Nodes, Dataset::IlmErrors, Dataset::Policies, Dataset::IlmAssign,
    Dataset::Snapshots, Dataset::SnapshotsFull, Dataset::Indices, Dataset::Shards,
];

/// How long an unreachable cluster waits between health probes, before jitter.
pub const UNREACHABLE_PROBE_MS: u64 = 120_000;
/// Clusters that appear together are spread over this window, so a restart with a
/// hundred clusters is not a hundred simultaneous health checks.
pub const BOOT_SPREAD_MS: u64 = 180_000;
/// An on-demand dataset is "watched" for this long after somebody last asked for it.
pub const WATCH_MS: u64 = 15 * 60_000;

/// One request inside a dataset. `key` is the name the UI already uses for that answer in
/// `buildClusterData`, so the cache hands back `{root, health}` and not `{q0, q1}`.
#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    pub key: String,
    pub path: String,
    pub timeout_ms: u64,
}

/// `encodeURIComponent`, because the UI used it to build these paths and the cache must
/// ask for the same thing.
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

const NODE_COLS: &str = "name,ip,version,jdk,node.role,master,heap.percent,heap.current,heap.max,ram.percent,cpu,load_1m,load_5m,disk.used,disk.avail,disk.total,disk.used_percent,uptime";
const INDEX_COLS: &str = "health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size,creation.date";
const TASK_COLS: &str = "action,task_id,parent_task_id,node,running_time,running_time_ns,type,description";

fn q(key: &str, path: String, timeout_ms: u64) -> Query {
    Query { key: key.to_string(), path, timeout_ms }
}

/// The request the UI's `snapshotsCat(repo)` made.
pub fn snapshots_cat_path(repo: &str) -> String {
    format!(
        "/_cat/snapshots/{}?format=json&s=end_epoch:desc&h=id,status,start_epoch,end_epoch,duration,indices,successful_shards,failed_shards,total_shards",
        enc(repo)
    )
}

/// The request the UI's `snapshots(repo, 500)` made: the verbose listing, with index names.
pub fn snapshots_full_path(repo: &str) -> String {
    format!("/_snapshot/{}/_all?ignore_unavailable=true&verbose=true&sort=start_time&order=desc&size=500", enc(repo))
}

/// Where the repository names come from: the `repos` answer of the `policies` dataset.
pub const REPOS_PATH: &str = "/_snapshot?local=false";

impl Dataset {
    pub fn name(self) -> &'static str {
        match self {
            Dataset::Health => "health",
            Dataset::Nodes => "nodes",
            Dataset::IlmErrors => "ilm_errors",
            Dataset::Policies => "policies",
            Dataset::IlmAssign => "ilm_assign",
            Dataset::Snapshots => "snapshots",
            Dataset::SnapshotsFull => "snapshots_full",
            Dataset::Indices => "indices",
            Dataset::Shards => "shards",
        }
    }

    pub fn parse(s: &str) -> Option<Dataset> {
        ALL.into_iter().find(|d| d.name() == s)
    }

    pub fn class(self) -> Class {
        match self {
            Dataset::SnapshotsFull | Dataset::Indices | Dataset::Shards => Class::OnDemand,
            _ => Class::Background,
        }
    }

    /// Seconds between fetches. For an on-demand dataset, while it is watched.
    pub fn interval_secs(self, health_secs: u64) -> u64 {
        match self {
            Dataset::Health => health_secs,
            Dataset::Nodes => 300,
            Dataset::IlmErrors => 900,
            Dataset::Policies => 3600,
            Dataset::IlmAssign => 3600,
            Dataset::Snapshots => 1800,
            Dataset::SnapshotsFull => 1800,
            Dataset::Indices => 600,
            Dataset::Shards => 300,
        }
    }

    /// When a value is old enough that the page should say so: two intervals, three for
    /// policies — a policy that changes once a quarter is not stale after two hours.
    pub fn stale_after_ms(self, health_secs: u64) -> u64 {
        let k = if self == Dataset::Policies { 3 } else { 2 };
        k * self.interval_secs(health_secs) * 1000
    }

    /// The requests, for everything except the per-repository datasets (see
    /// `repo_queries`). `log_pattern` is the cluster's `logIndexPattern`.
    pub fn queries(self, log_pattern: Option<&str>) -> Vec<Query> {
        let t = 15_000;
        match self {
            Dataset::Health => vec![q("root", "/".into(), t), q("health", "/_cluster/health".into(), t)],
            Dataset::Nodes => vec![
                q("nodes", format!("/_cat/nodes?format=json&bytes=b&h={}", enc(NODE_COLS)), t),
                q("alloc", "/_cat/allocation?format=json&bytes=b".into(), t),
            ],
            Dataset::IlmErrors => vec![q("ilmErr", "/*/_ilm/explain?only_errors=true&only_managed=true".into(), 30_000)],
            Dataset::Policies => vec![
                q("repos", REPOS_PATH.into(), t),
                q("slm", "/_slm/policy".into(), t),
                q("slmStatus", "/_slm/status".into(), t),
                q("ilm", "/_ilm/status".into(), t),
                q("ilmPolicies", "/_ilm/policy".into(), t),
                q("repoPaths", "/_nodes/settings?filter_path=nodes.*.settings.path.repo,nodes.*.name".into(), t),
                q("clusterSettings", "/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=**.disk.watermark**,**.allocation.enable,**.rebalance.enable".into(), t),
            ],
            Dataset::IlmAssign => {
                let p = log_pattern.map(str::trim).filter(|p| !p.is_empty()).unwrap_or("*");
                vec![q(
                    "ilmOfIndices",
                    format!("/{}/_settings?filter_path=*.settings.index.lifecycle.name&expand_wildcards=open&ignore_unavailable=true&allow_no_indices=true", enc(p)),
                    t,
                )]
            }
            Dataset::Indices => vec![q(
                "indices",
                format!("/_cat/indices/{}?format=json&bytes=b&expand_wildcards=open,closed&h={}", enc("*"), enc(INDEX_COLS)),
                30_000,
            )],
            Dataset::Shards => vec![
                q("shards", "/_cat/shards?format=json&bytes=b&h=index,shard,prirep,state,node,store,docs,unassigned.reason&s=index,shard".into(), 30_000),
                q("tasks", format!("/_cat/tasks?format=json&detailed&h={}", enc(TASK_COLS)), t),
                q("threadPools", "/_cat/thread_pool/search,write,get,bulk?format=json&h=node_name,name,active,queue,rejected,completed".into(), t),
                q("pendingTasks", "/_cluster/pending_tasks".into(), t),
            ],
            Dataset::Snapshots | Dataset::SnapshotsFull => vec![],
        }
    }

    /// The per-repository request, for the two snapshot datasets.
    pub fn repo_query(self, repo: &str) -> Option<Query> {
        match self {
            Dataset::Snapshots => Some(q(repo, snapshots_cat_path(repo), 30_000)),
            Dataset::SnapshotsFull => Some(q(repo, snapshots_full_path(repo), 60_000)),
            _ => None,
        }
    }

    /// Every path this dataset can send, with a stand-in repository name. What the guest
    /// check is asked about, so it is decided by the same allowlist as a guest's ES read.
    fn sample_paths(self) -> Vec<String> {
        match self {
            Dataset::Snapshots | Dataset::SnapshotsFull => {
                let mut v = vec![REPOS_PATH.to_string()];
                v.extend(self.repo_query("repo").map(|q| q.path));
                v
            }
            _ => self.queries(None).into_iter().map(|q| q.path).collect(),
        }
    }

    /// A guest sees a dataset only if a guest could have made every one of its requests.
    pub fn guest_may_read(self) -> bool {
        self.sample_paths().iter().all(|p| crate::auth::guest_may_read(p))
    }
}

/// `interval ± 10 %`, with `r` in [-1, 1]. Pure, so the bounds can be tested.
pub fn jitter_ms(interval_ms: u64, r: f64) -> u64 {
    let r = r.clamp(-1.0, 1.0);
    (interval_ms as f64 * (1.0 + 0.1 * r)).round() as u64
}

pub fn jittered_ms(interval_ms: u64) -> u64 {
    use rand::Rng;
    jitter_ms(interval_ms, rand::thread_rng().gen_range(-1.0..=1.0))
}

/// Where cluster `i` of `n` new ones starts: evenly across the boot window.
pub fn boot_offset_ms(i: usize, n: usize) -> u64 {
    if n == 0 {
        return 0;
    }
    (i as u64).saturating_mul(BOOT_SPREAD_MS) / n as u64
}

/// The datasets a request that changed something makes out of date. `None` for a read.
///
/// Matched on the first path segment, because that is where Elasticsearch puts the API:
/// `/_snapshot/...` is a repository or a snapshot, a name without an underscore is an
/// index.
pub fn datasets_for_write(method: &str, path: &str) -> Vec<Dataset> {
    use Dataset::*;
    if crate::guard::is_read(method, path) {
        return vec![];
    }
    let bare = path.split('?').next().unwrap_or("/");
    let segs: Vec<&str> = bare.split('/').filter(|s| !s.is_empty()).collect();
    let Some(first) = segs.first() else { return vec![] };
    match *first {
        "_snapshot" => vec![Snapshots, SnapshotsFull, Policies],
        // Executing an SLM policy takes a snapshot, so the listings change too.
        "_slm" if segs.last() == Some(&"_execute") => vec![Policies, IlmErrors, Snapshots, SnapshotsFull],
        "_slm" | "_ilm" => vec![Policies, IlmErrors],
        "_cluster" => match segs.get(1).copied() {
            Some("settings") => vec![Policies],
            Some("reroute") => vec![Shards, Nodes],
            _ => vec![],
        },
        "_tasks" => vec![Shards],
        // Security, licences, templates, pipelines: nothing the cache holds.
        f if f.starts_with('_') => vec![],
        // An index: created, deleted, opened, closed, re-set. Its ILM moves count too.
        _ => {
            let mut v = vec![Indices, Shards, Health];
            if segs.contains(&"_ilm") {
                v.extend([IlmErrors, IlmAssign]);
            } else if segs.contains(&"_settings") {
                v.push(IlmAssign);
            }
            v
        }
    }
}

/// The catalogue as the UI reads it from `FLEET_STATE.catalogue`.
pub fn catalogue_json(health_secs: u64) -> Value {
    Value::Array(
        ALL.iter()
            .map(|d| {
                json!({
                    "dataset": d.name(),
                    "class": d.class(),
                    "intervalSec": d.interval_secs(health_secs),
                    "staleAfterMs": d.stale_after_ms(health_secs),
                    "guest": d.guest_may_read(),
                    "keys": match d {
                        Dataset::Snapshots | Dataset::SnapshotsFull => json!(["byRepo"]),
                        _ => json!(d.queries(None).iter().map(|q| q.key.clone()).collect::<Vec<_>>()),
                    },
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_match_what_the_ui_built() {
        // es.js: `/_cat/nodes?format=json&bytes=b&h=${encodeURIComponent(h)}`
        assert!(Dataset::Nodes.queries(None)[0].path.starts_with("/_cat/nodes?format=json&bytes=b&h=name%2Cip%2Cversion%2Cjdk"));
        assert_eq!(Dataset::Indices.queries(None)[0].path,
            "/_cat/indices/*?format=json&bytes=b&expand_wildcards=open,closed&h=health%2Cstatus%2Cindex%2Cuuid%2Cpri%2Crep%2Cdocs.count%2Cdocs.deleted%2Cstore.size%2Cpri.store.size%2Ccreation.date");
        assert_eq!(Dataset::IlmAssign.queries(Some("logs-*"))[0].path,
            "/logs-*/_settings?filter_path=*.settings.index.lifecycle.name&expand_wildcards=open&ignore_unavailable=true&allow_no_indices=true");
        assert_eq!(Dataset::IlmAssign.queries(None)[0].path.split('/').nth(1), Some("*"));
        assert_eq!(snapshots_full_path("my repo"), "/_snapshot/my%20repo/_all?ignore_unavailable=true&verbose=true&sort=start_time&order=desc&size=500");
        assert!(snapshots_cat_path("r").starts_with("/_cat/snapshots/r?format=json&s=end_epoch:desc&h=id,status"));
        assert_eq!(enc("a/b:c"), "a%2Fb%3Ac");
    }

    #[test]
    fn intervals_and_staleness() {
        assert_eq!(Dataset::Health.interval_secs(180), 180);
        assert_eq!(Dataset::Nodes.interval_secs(180), 300);
        assert_eq!(Dataset::Snapshots.interval_secs(180), 1800);
        assert_eq!(Dataset::Health.stale_after_ms(180), 360_000);
        assert_eq!(Dataset::Policies.stale_after_ms(180), 3 * 3_600_000);
        assert_eq!(Dataset::Indices.class(), Class::OnDemand);
        assert_eq!(Dataset::Snapshots.class(), Class::Background);
        for d in ALL {
            assert_eq!(Dataset::parse(d.name()), Some(d));
        }
    }

    #[test]
    fn jitter_stays_within_ten_percent() {
        assert_eq!(jitter_ms(180_000, -1.0), 162_000);
        assert_eq!(jitter_ms(180_000, 1.0), 198_000);
        assert_eq!(jitter_ms(180_000, 5.0), 198_000, "out-of-range randomness is clamped");
        for _ in 0..1000 {
            let j = jittered_ms(120_000);
            assert!((108_000..=132_000).contains(&j), "{j}");
        }
    }

    #[test]
    fn boot_spread_is_even_and_inside_the_window() {
        assert_eq!(boot_offset_ms(0, 4), 0);
        assert_eq!(boot_offset_ms(1, 4), 45_000);
        assert_eq!(boot_offset_ms(3, 4), 135_000);
        assert!(boot_offset_ms(119, 120) < BOOT_SPREAD_MS);
        assert_eq!(boot_offset_ms(0, 0), 0);
    }

    #[test]
    fn a_guest_gets_health_and_nodes_only() {
        let g: Vec<&str> = ALL.iter().filter(|d| d.guest_may_read()).map(|d| d.name()).collect();
        assert_eq!(g, vec!["health", "nodes"]);
    }

    #[test]
    fn writes_map_to_the_datasets_they_change() {
        use Dataset::*;
        assert_eq!(datasets_for_write("GET", "/_snapshot/r/s"), vec![]);
        assert_eq!(datasets_for_write("POST", "/logs-*/_search"), vec![], "a search is a read");
        assert_eq!(datasets_for_write("PUT", "/_snapshot/r/s?wait_for_completion=false"), vec![Snapshots, SnapshotsFull, Policies]);
        assert_eq!(datasets_for_write("POST", "/_slm/policy/daily/_execute"), vec![Policies, IlmErrors, Snapshots, SnapshotsFull]);
        assert_eq!(datasets_for_write("PUT", "/_slm/policy/daily"), vec![Policies, IlmErrors]);
        assert_eq!(datasets_for_write("PUT", "/_cluster/settings"), vec![Policies]);
        assert_eq!(datasets_for_write("POST", "/_cluster/reroute?retry_failed=true"), vec![Shards, Nodes]);
        assert_eq!(datasets_for_write("DELETE", "/logs-2026.01.01"), vec![Indices, Shards, Health]);
        assert_eq!(datasets_for_write("POST", "/idx/_close"), vec![Indices, Shards, Health]);
        assert_eq!(datasets_for_write("PUT", "/idx/_settings"), vec![Indices, Shards, Health, IlmAssign]);
        assert_eq!(datasets_for_write("PUT", "/_security/user/bob"), vec![]);
    }
}
