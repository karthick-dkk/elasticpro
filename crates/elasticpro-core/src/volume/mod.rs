//! The daily index-volume record (docs/VOLUME.md is the contract; read it first).
//!
//! Once a day — hosted only, at `collectAt` server local time — and whenever somebody
//! presses Refresh now, the core asks each cluster three things: `_cat/indices` on the
//! day-index glob (sizes per day, from the index names), `_field_caps` (which field each
//! breakdown row resolves to), and one aggregation search per day that is not finished
//! yet. What comes back is kept on disk per cluster and month, so the record outlives the
//! indices it was measured from: a day whose indices were deleted stays, `live: false`.
//!
//! The figures the pages, the CSV and the mails show are worked out here, once
//! (`derive`). None of them does the arithmetic again — that is this codebase's named
//! recurring failure, and a size per day is exactly the kind of figure it drifted on.
//!
//! ```text
//!   tick (60 s, hosted) ─┐            VOLUME_RUN (anyone, ≤ 1/min/cluster) ─┐
//!                        └── due? ──▶ run(cluster) ◀────────────────────────┘
//!                                      ├── _cat/indices/<glob>     totals, live flags
//!                                      ├── _field_caps             rows resolved
//!                                      ├── _search × unfinished    docs, sums, terms
//!                                      └── month files + state.json, then prune
//! ```
//!
//! Memory: production runs under a 1 GB limit, so nothing here holds the record between
//! requests. Each message reads the month files it needs and lets them go; the all-cluster
//! Monthly view reads only `state.json`, where the month summaries are kept.

pub mod collect;
pub mod derive;
pub mod schedule;
pub mod settings;
pub mod store;
pub(crate) mod run;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use settings::{SizeBasis, VolumeSettings};

/// The breakdown rows, in the order the pages list them. `extra` is the one whose name
/// the operator chooses (`extra.name`).
pub const FIELD_KEYS: [&str; 5] = ["tag", "forwarder", "sourceHost", "sourceIp", "extra"];

/// Columns of the Daily table, in their default order, then the ones hidden by default.
pub const DAILY_COLUMNS: &[&str] = &[
    "day", "indices", "docs", "priBytes", "topExtra", "eventBytes", "subBytes", "changeVsAvg",
    "topSourceHost", "topForwarder", "totalBytes", "topTag", "topSourceIp",
];
pub const DAILY_HIDDEN: &[&str] = &["totalBytes", "topTag", "topSourceIp"];
pub const MONTHLY_COLUMNS: &[&str] = &[
    "month", "daysWithData", "priBytes", "topExtra", "avgPerDay", "peakDay", "docs", "eventBytes",
    "subBytes", "topSourceHost", "topForwarder", "from",
];

/// A column's name when the shared layout gives it none (`labels` in `VOLUME_LAYOUT_*`).
/// One definition for every place that writes a header: the report's sheets now, the pages
/// when they ask. `extra` is the operator's name for the extra breakdown (`extra.name`).
pub fn column_label(table: &str, key: &str, extra: &str) -> String {
    let fixed = match (table, key) {
        (_, "topExtra") => return format!("Top {extra}"),
        ("daily", "day") => "Day",
        ("monthly", "month") => "Month",
        ("monthly", "daysWithData") => "Days with data",
        ("monthly", "avgPerDay") => "Average per day",
        ("monthly", "peakDay") => "Peak day",
        ("monthly", "from") => "Kept record days",
        (_, "indices") => "Indices",
        (_, "docs") => "Documents",
        (_, "priBytes") => "Primary size",
        (_, "totalBytes") => "Total size",
        (_, "eventBytes") => "Event bytes",
        (_, "subBytes") => "Sub size",
        (_, "changeVsAvg") => "Change vs average %",
        (_, "topSourceHost") => "Top source host",
        (_, "topForwarder") => "Top forwarder",
        (_, "topTag") => "Top tag",
        (_, "topSourceIp") => "Top source IP",
        _ => key,
    };
    fixed.to_string()
}

/// One day of one cluster, as kept. `None` is "not measured" all the way to the page,
/// which renders it as such and never as 0.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// `YYYY-MM-DD`, the date in the index names.
    pub day: String,
    /// Aggregated after the day was over (UTC). A final day is never asked again.
    #[serde(rename = "final")]
    pub is_final: bool,
    /// The day still has indices. Once false it is never changed again: the record is
    /// all that is left of it.
    pub live: bool,
    pub aggregated_at: Option<i64>,
    pub totals_at: i64,
    pub indices: u64,
    pub pri_bytes: u64,
    pub total_bytes: u64,
    pub docs: Option<u64>,
    pub event_bytes: Option<u64>,
    pub sub_bytes: Option<u64>,
    #[serde(default)]
    pub sources: BTreeMap<String, SourceTotals>,
    #[serde(default)]
    pub fields: BTreeMap<String, FieldAgg>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTotals {
    pub indices: u64,
    pub pri_bytes: u64,
    pub total_bytes: u64,
    pub docs: Option<u64>,
    pub event_bytes: Option<u64>,
    pub sub_bytes: Option<u64>,
}

/// One breakdown row on one day. `error` set means the field could not be resolved: the
/// counts beside it are not measurements and nothing reads them as such.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldAgg {
    pub field: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub top: Vec<TopValue>,
    pub other_docs: u64,
    pub missing_docs: u64,
    pub other_event_bytes: Option<u64>,
    pub missing_event_bytes: Option<u64>,
    pub other_sub_bytes: Option<u64>,
    pub missing_sub_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopValue {
    pub value: String,
    pub docs: u64,
    pub event_bytes: Option<u64>,
    pub sub_bytes: Option<u64>,
}

/// What one run of one cluster is doing right now. In memory on purpose: it is about
/// this process, and a restart that forgot it would be telling the truth.
#[derive(Clone, Debug, Default)]
pub(crate) struct RunState {
    pub running: bool,
    pub done: u64,
    pub total: u64,
    /// When `VOLUME_RUN` last started this cluster, for the once-a-minute limit.
    pub asked_at: Option<u64>,
}

/// The core's handle on the record: the store, and the runs in progress.
pub struct Volume {
    pub(crate) store: Option<store::Store>,
    pub(crate) runs: parking_lot::Mutex<std::collections::HashMap<String, RunState>>,
    /// At most two clusters at once, whoever started them. Within a cluster everything is
    /// sequential, so a cluster never sees more than one of these requests at a time.
    pub(crate) permits: std::sync::Arc<tokio::sync::Semaphore>,
    /// One tick at a time: a tick that is still deciding when the next fires does nothing.
    pub(crate) ticking: std::sync::atomic::AtomicBool,
}

/// Clusters collected at once, timer and Refresh now together.
pub const PARALLEL_CLUSTERS: usize = 2;
/// The least time between two Refresh-now runs of one cluster.
pub const RUN_EVERY_MS: u64 = 60_000;

impl Volume {
    pub fn open(data_dir: Option<&std::path::Path>) -> Volume {
        Volume {
            store: data_dir.map(|d| store::Store::new(d.join("volume"))),
            runs: parking_lot::Mutex::new(Default::default()),
            permits: std::sync::Arc::new(tokio::sync::Semaphore::new(PARALLEL_CLUSTERS)),
            ticking: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
