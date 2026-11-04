//! ElasticPro's own health and performance (docs/HEALTH.md): is the core well, is the report
//! worker well, is anything queueing, and is a report pushing too hard.
//!
//! Everything here is about this process and its neighbour, never about a cluster: opening the
//! Request Centre's *ElasticPro health* tab sends no cluster anything.
//!
//! What lives here, pure and tested, with the I/O at the edges:
//!
//! * **Samplers** — cgroup v2 `memory.current` (less `inactive_file`, as `docker stats` counts
//!   it), `memory.max`, `memory.events` (`oom_kill`), `cpu.stat` and `cpu.max`; `/proc/self/status`
//!   (`VmRSS`, `VmHWM`) when the cgroup files are absent; `statvfs` for the data volume. A file
//!   that is not there is *not known*, never zero (macOS has none of them).
//! * **The ring** — one [`Sample`] a minute for 24 h, persisted to `<data>/health/<role>.json`
//!   every ten minutes so a restart keeps the day.
//! * **Message timing** — one fixed-bucket histogram per message type per minute, the last hour
//!   kept ([`MessageTimes`]); percentiles are bucket upper bounds.
//! * **Checks** — the amber/red table of docs/HEALTH.md, every threshold a constant below, each
//!   line with what it means and the setting that fixes it ([`evaluate`]).
//! * **[`WorkerStatus`]** — the schema of `<data>/worker/status.json`, which the report worker
//!   (docs/WORKER.md) writes every ten seconds and the core reads. The worker builds its memory,
//!   CPU and gate figures with the same functions the core uses ([`SelfMonitor`],
//!   [`gate_figures`]), so a figure means the same on both sides.
//!
//! The core's glue — what it holds, `SYSTEM_HEALTH`, the minute task — is `bridge::system_health`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

/* ------------------------------------------ constants ------------------------------------------ */

/// One sample a minute.
pub const SAMPLE_EVERY_SECS: u64 = 60;
pub const MINUTE_MS: u64 = 60_000;
pub const DAY_MS: u64 = 24 * 60 * MINUTE_MS;
/// A day of minutes, and a little slack for a clock that ran fast.
pub const RING_KEEP: usize = 24 * 60 + 10;
/// The ring is written every this many samples (ten minutes).
pub const PERSIST_EVERY_SAMPLES: u64 = 10;
/// Directory sizes are measured every this many samples (ten minutes): it walks the volume.
pub const DISK_EVERY_SAMPLES: u64 = 10;
/// The most entries one directory walk reads before it says "at least".
pub const WALK_CAP: usize = 200_000;
/// Where the ring is kept, under the data directory.
pub const HEALTH_DIR: &str = "health";
/// The worker's status file, under the data directory (docs/WORKER.md "Who owns what").
pub const WORKER_STATUS_FILE: &str = "worker/status.json";
/// How often the worker rewrites its status file.
pub const WORKER_HEARTBEAT_SECS: u64 = 10;
/// The schema of `worker/status.json` this core reads. A worker writing a newer one is shown
/// as far as the fields agree; every field is optional on read.
pub const WORKER_STATUS_SCHEMA: u32 = 1;
/// A scheduled dataset this long past its due time is late.
pub const LATE_AFTER_MS: u64 = 30_000;

// The thresholds of docs/HEALTH.md "Checks". One place; the tab shows them from `THRESHOLDS`.
pub const MEM_AMBER_PCT: f64 = 80.0;
pub const MEM_RED_PCT: f64 = 90.0;
pub const THROTTLE_AMBER_PCT: f64 = 10.0;
pub const THROTTLE_RED_PCT: f64 = 30.0;
pub const P95_AMBER_MS: u64 = 1_000;
pub const P95_RED_MS: u64 = 3_000;
pub const REFUSED_AMBER: u64 = 1;
pub const REFUSED_RED: u64 = 20;
pub const LATE_AMBER_PCT: f64 = 5.0;
pub const LATE_RED_PCT: f64 = 20.0;
pub const HEARTBEAT_AMBER_SECS: u64 = 30;
pub const HEARTBEAT_RED_SECS: u64 = 90;
pub const DISK_FREE_AMBER_PCT: f64 = 15.0;
pub const DISK_FREE_RED_PCT: f64 = 5.0;

/// One line of the thresholds table, as the tab shows it.
#[derive(Clone, Debug, Serialize)]
pub struct Threshold {
    pub id: &'static str,
    pub check: &'static str,
    pub amber: &'static str,
    pub red: &'static str,
}

pub const THRESHOLDS: &[Threshold] = &[
    Threshold { id: "memory", check: "Resident memory of limit (core, worker)", amber: "≥ 80%", red: "≥ 90%, or an OOM kill in 24 h" },
    Threshold { id: "cpu", check: "CPU throttled (last 5 min)", amber: "≥ 10% of periods", red: "≥ 30%" },
    Threshold { id: "messages", check: "Message p95 (5 min, all types that wait on nothing outside the core)", amber: "≥ 1 s", red: "≥ 3 s" },
    Threshold { id: "gate", check: "Gate overloaded + queue_timeout (5 min)", amber: "≥ 1", red: "≥ 20" },
    Threshold { id: "poller", check: "Poller late datasets", amber: "≥ 5%", red: "≥ 20%" },
    Threshold { id: "worker", check: "Worker heartbeat age", amber: "≥ 30 s", red: "≥ 90 s, or version mismatch" },
    Threshold { id: "disk", check: "Data volume free", amber: "≤ 15%", red: "≤ 5%" },
];

/// Messages whose handling time is somebody else's by definition: a cluster's (ES, a dataset
/// held open for the poller), Zabbix's, a mail server's, or a password hash that is slow on
/// purpose. They are in the per-type table; the "all types" p95 check leaves them out, so a
/// slow cluster shows under *Request gate* and does not turn the core amber.
pub const WAITS_ELSEWHERE: &[&str] = &[
    "ES", "CLUSTER_DATASET", "REFRESH", "PRIME", "TUNNEL_RECONNECT", "TRUST_CERT", "TRUST_HOSTKEY",
    "ZABBIX_SYNC", "ZABBIX_METRICS", "ZABBIX_LINK_TEST", "ZABBIX_PAIR_BEGIN", "ZABBIX_ROLEMAP_SET",
    "MAIL_TEST", "REPORT_SEND_NOW", "HISTORY_STORE_TEST", "HISTORY_STORE_BACKFILL", "HISTORY_QUERY",
    "VOLUME_PATTERN_CHECK", "VOLUME_FIELDS_CHECK", "VOLUME_RUN", "DELAY_SINK_RUN", "HOUSEKEEPING_RUN",
    "LOGIN", "SSO_EXCHANGE", "BOOTSTRAP_ADMIN", "USER_ADD", "USER_SET_PASSWORD", "SEAL", "OPEN",
    "CONFIG_WRITE", "CLUSTER_SAVE", "CREDENTIAL_SET",
];

/* -------------------------------------------- level -------------------------------------------- */

/// How a check, or a part, stands. `Unknown`: it cannot report — shown as *not known*, never
/// green. `Off`: not deployed or not configured, which is not a fault.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    Unknown,
    Off,
    Ok,
    Warn,
    Bad,
}

impl Level {
    fn rank(self) -> u8 {
        match self {
            Level::Unknown | Level::Off | Level::Ok => 0,
            Level::Warn => 1,
            Level::Bad => 2,
        }
    }

    /// What `PING` carries for an administrator: `ok`, `warn` or `bad`.
    pub fn ping(self) -> &'static str {
        match self {
            Level::Warn => "warn",
            Level::Bad => "bad",
            _ => "ok",
        }
    }

    fn of_high(v: f64, amber: f64, red: f64) -> Level {
        if v >= red {
            Level::Bad
        } else if v >= amber {
            Level::Warn
        } else {
            Level::Ok
        }
    }
}

/// The worst of the checks: red if any is red, amber if any is amber, else ok (a part that
/// cannot report does not turn the dot amber; the tab says *not known* where it is).
pub fn overall(checks: &[Check]) -> Level {
    match checks.iter().map(|c| c.level.rank()).max().unwrap_or(0) {
        2 => Level::Bad,
        1 => Level::Warn,
        _ => Level::Ok,
    }
}

/* ------------------------------------------- samplers ------------------------------------------ */

/// `key value` lines (`cpu.stat`, `memory.events`, `memory.stat`): the value of `key`.
pub fn parse_kv(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        (it.next() == Some(key)).then(|| it.next()?.parse().ok()).flatten()
    })
}

/// `cpu.stat` counters. `usage_usec` is always there on v2; the throttling ones only under a
/// CPU controller.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpuStat {
    pub usage_usec: u64,
    pub nr_periods: Option<u64>,
    pub nr_throttled: Option<u64>,
    pub throttled_usec: Option<u64>,
}

pub fn parse_cpu_stat(text: &str) -> Option<CpuStat> {
    Some(CpuStat {
        usage_usec: parse_kv(text, "usage_usec")?,
        nr_periods: parse_kv(text, "nr_periods"),
        nr_throttled: parse_kv(text, "nr_throttled"),
        throttled_usec: parse_kv(text, "throttled_usec"),
    })
}

/// `cpu.max` (`<quota> <period>` or `max <period>`): the CPUs the container may use, or
/// `None` for no limit.
pub fn parse_cpu_max(text: &str) -> Option<f64> {
    let mut it = text.split_whitespace();
    let quota: f64 = it.next()?.parse().ok()?;
    let period: f64 = it.next().and_then(|p| p.parse().ok()).unwrap_or(100_000.0);
    (quota > 0.0 && period > 0.0).then(|| quota / period)
}

/// `/proc/self/status`: `(VmRSS, VmHWM)` in bytes.
pub fn parse_proc_status(text: &str) -> (Option<u64>, Option<u64>) {
    let kb = |key: &str| {
        text.lines().find_map(|l| {
            let rest = l.strip_prefix(key)?.trim();
            rest.split_whitespace().next()?.parse::<u64>().ok().map(|v| v * 1024)
        })
    };
    (kb("VmRSS:"), kb("VmHWM:"))
}

/// One reading of this process (or its container): what the minute task and the worker take.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Raw {
    pub at: u64,
    pub rss: Option<u64>,
    pub rss_source: &'static str,
    pub hwm: Option<u64>,
    pub limit: Option<u64>,
    pub limit_source: &'static str,
    pub oom_kills: Option<u64>,
    pub cpu: Option<CpuStat>,
    pub cpu_limit: Option<f64>,
}

/// Where the samplers read. `Default` is the real place; the tests point it at fixtures.
#[derive(Clone, Debug)]
pub struct Sampler {
    pub cgroup: PathBuf,
    pub proc_status: PathBuf,
}

impl Default for Sampler {
    fn default() -> Sampler {
        Sampler { cgroup: PathBuf::from("/sys/fs/cgroup"), proc_status: PathBuf::from("/proc/self/status") }
    }
}

impl Sampler {
    pub fn read(&self, at: u64) -> Raw {
        let read = |name: &str| std::fs::read_to_string(self.cgroup.join(name)).ok();
        let (vm_rss, vm_hwm) = std::fs::read_to_string(&self.proc_status).map(|t| parse_proc_status(&t)).unwrap_or((None, None));
        // As `docker stats` counts it: the cgroup's charge less the page cache it can drop.
        let current = read("memory.current").and_then(|t| t.trim().parse::<u64>().ok());
        let (rss, rss_source) = match current {
            Some(c) => {
                let inactive = read("memory.stat").and_then(|t| parse_kv(&t, "inactive_file")).unwrap_or(0);
                (Some(c.saturating_sub(inactive)), "cgroup memory.current less inactive_file")
            }
            None => match vm_rss {
                Some(r) => (Some(r), "/proc/self/status VmRSS"),
                None => (None, "not known"),
            },
        };
        let (limit, limit_source) = match crate::memory::read_cgroup_limit(&self.cgroup) {
            Some((l, src)) => (Some(l), src),
            None => (None, "none"),
        };
        Raw {
            at,
            rss,
            rss_source,
            hwm: vm_hwm,
            limit,
            limit_source,
            oom_kills: read("memory.events").and_then(|t| parse_kv(&t, "oom_kill")),
            cpu: read("cpu.stat").and_then(|t| parse_cpu_stat(&t)),
            cpu_limit: read("cpu.max").and_then(|t| parse_cpu_max(&t)),
        }
    }
}

/// `(total, available)` bytes of the filesystem holding `path`.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, clippy::useless_conversion)]
pub fn statvfs(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` writes into the struct we own and reads a NUL-terminated path.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let unit = if s.f_frsize as u64 > 0 { s.f_frsize as u64 } else { s.f_bsize as u64 };
    Some((s.f_blocks as u64 * unit, s.f_bavail as u64 * unit))
}

#[cfg(not(unix))]
pub fn statvfs(_: &Path) -> Option<(u64, u64)> {
    None
}

/// Bytes and files under `root`, symlinks not followed. `truncated`: the walk stopped at
/// `cap` entries and the size is a floor.
pub fn dir_size(root: &Path, cap: usize) -> (u64, u64, bool) {
    let (mut bytes, mut files, mut seen) = (0u64, 0u64, 0usize);
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > cap {
                return (bytes, files, true);
            }
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else if m.is_file() {
                bytes += m.len();
                files += 1;
            }
        }
    }
    (bytes, files, false)
}

/* --------------------------------------------- ring -------------------------------------------- */

/// One minute of this process, kept for 24 h. Cumulative counters (`oom`, CPU) are kept as
/// read; per-minute ones (`overloaded`, `queueTimeout`) are the minute's own.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sample {
    pub t: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rss: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oom: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_usec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub periods: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub throttled: Option<u64>,
    /// Message p95 over the minute (types that wait on nothing outside the core).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p95_ms: Option<u64>,
    /// Requests waiting at the gate when the sample was taken.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_timeout: Option<u64>,
    /// The worker's resident memory and its reports' concurrency (all running jobs together),
    /// from its status file — the core's ring carries the worker's trend too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_rss: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_conc: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ring {
    #[serde(default)]
    pub samples: VecDeque<Sample>,
}

#[derive(Serialize, Deserialize)]
struct RingFile {
    version: u32,
    role: String,
    #[serde(default)]
    samples: VecDeque<Sample>,
}

impl Ring {
    pub fn push(&mut self, s: Sample) {
        let now = s.t;
        self.samples.push_back(s);
        self.trim(now);
    }

    fn trim(&mut self, now: u64) {
        while self.samples.front().is_some_and(|f| now.saturating_sub(f.t) > DAY_MS) || self.samples.len() > RING_KEEP {
            self.samples.pop_front();
        }
    }

    pub fn last(&self) -> Option<&Sample> {
        self.samples.back()
    }

    /// Samples taken within `ms` of `now`, oldest first.
    pub fn within(&self, now: u64, ms: u64) -> impl Iterator<Item = &Sample> {
        self.samples.iter().filter(move |s| now.saturating_sub(s.t) <= ms && s.t <= now)
    }

    pub fn to_json(&self, role: &str) -> Vec<u8> {
        serde_json::to_vec(&RingFile { version: 1, role: role.to_string(), samples: self.samples.clone() }).unwrap_or_default()
    }

    /// A ring from its file: what is older than a day is dropped, and a file that does not
    /// parse is an empty ring (the day starts again; nothing is invented).
    pub fn from_json(bytes: &[u8], now: u64) -> Ring {
        let mut r = Ring { samples: serde_json::from_slice::<RingFile>(bytes).map(|f| f.samples).unwrap_or_default() };
        r.samples.retain(|s| s.t <= now);
        r.trim(now);
        r
    }

    pub fn path(data: &Path, role: &str) -> PathBuf {
        data.join(HEALTH_DIR).join(format!("{role}.json"))
    }

    pub fn load(data: &Path, role: &str, now: u64) -> Ring {
        std::fs::read(Ring::path(data, role)).map(|b| Ring::from_json(&b, now)).unwrap_or_default()
    }

    pub fn save(&self, data: &Path, role: &str) -> Result<(), String> {
        crate::volume::store::write_atomic(&Ring::path(data, role), &self.to_json(role))
    }

    /// The highest resident memory in the last day, `current` included.
    pub fn peak_rss(&self, now: u64, current: Option<u64>) -> Option<u64> {
        self.within(now, DAY_MS).filter_map(|s| s.rss).chain(current).max()
    }

    /// OOM kills in the last day: the rises of the cumulative counter across the day's samples
    /// and `current`. A counter that went down was reset (a new container): its new value is
    /// all new kills. `None` when nothing in the day read the counter.
    pub fn oom_kills_24h(&self, now: u64, current: Option<u64>) -> Option<u64> {
        let seq: Vec<u64> = self.within(now, DAY_MS).filter_map(|s| s.oom).chain(current).collect();
        seq.first()?;
        Some(seq.windows(2).map(|w| if w[1] >= w[0] { w[1] - w[0] } else { w[1] }).sum())
    }

    /// The share of CPU periods throttled over the last `ms`, to `current`.
    pub fn throttled_pct(&self, now: u64, ms: u64, current: Option<&CpuStat>) -> Option<f64> {
        let cur = current?;
        let (p1, t1) = (cur.nr_periods?, cur.nr_throttled?);
        let base = self.within(now, ms).find(|s| s.periods.is_some() && s.throttled.is_some())?;
        let (p0, t0) = (base.periods?, base.throttled?);
        if p1 < p0 || t1 < t0 {
            return None;
        }
        let dp = p1 - p0;
        Some(if dp == 0 { 0.0 } else { (t1 - t0) as f64 * 100.0 / dp as f64 })
    }

    /// `overloaded + queue_timeout` summed over the minutes of the last hour.
    pub fn refusals_within(&self, now: u64, ms: u64) -> Option<(u64, u64)> {
        let mut any = false;
        let (mut o, mut q) = (0, 0);
        for s in self.within(now, ms) {
            if let (Some(a), Some(b)) = (s.overloaded, s.queue_timeout) {
                any = true;
                o += a;
                q += b;
            }
        }
        any.then_some((o, q))
    }
}

/// CPU % (of one CPU) between a previous reading and now.
pub fn cpu_pct(prev_t: u64, prev_usec: u64, now_t: u64, now_usec: u64) -> Option<f64> {
    let dt_us = now_t.checked_sub(prev_t)?.checked_mul(1000)?;
    let du = now_usec.checked_sub(prev_usec)?;
    (dt_us > 0).then(|| du as f64 * 100.0 / dt_us as f64)
}

/* ------------------------------------- memory and CPU figures ---------------------------------- */

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryFigures {
    pub rss_bytes: Option<u64>,
    pub rss_source: String,
    pub limit_bytes: Option<u64>,
    /// `cgroup v2`, `cgroup v1`, or `none` (no limit).
    pub limit_source: String,
    pub used_pct: Option<f64>,
    pub peak_bytes_24h: Option<u64>,
    /// The process's own high-water mark (`VmHWM`), since it started.
    pub hwm_bytes: Option<u64>,
    /// OOM kills since the container started (`memory.events`).
    pub oom_kills: Option<u64>,
    pub oom_kills_24h: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CpuFigures {
    /// Whether `cpu.stat` could be read at all (no cgroup: everything below is not known).
    pub readable: bool,
    /// Percent of one CPU over the last minute.
    pub pct_1m: Option<f64>,
    pub limit_cpus: Option<f64>,
    /// `pct_1m` against the limit.
    pub pct_of_limit: Option<f64>,
    pub throttled_pct_5m: Option<f64>,
    pub nr_periods: Option<u64>,
    pub nr_throttled: Option<u64>,
    pub throttled_usec: Option<u64>,
}

/// A process watching itself: the sampler, its ring and the reading before this one. The core
/// holds one; the worker holds one and writes what [`SelfMonitor::figures`] gives into its
/// status file.
#[derive(Debug, Default)]
pub struct SelfMonitor {
    pub sampler: Sampler,
    pub ring: Ring,
    pub raw: Option<Raw>,
    prev_cpu: Option<(u64, u64)>,
    pct_1m: Option<f64>,
}

impl SelfMonitor {
    pub fn new(sampler: Sampler, ring: Ring) -> SelfMonitor {
        let prev_cpu = ring.last().and_then(|s| Some((s.t, s.cpu_usec?)));
        SelfMonitor { sampler, ring, raw: None, prev_cpu, pct_1m: None }
    }

    /// Read now. Returns the reading; the caller adds its own fields to the [`Sample`] that
    /// [`SelfMonitor::sample`] starts and pushes it with [`SelfMonitor::push`].
    pub fn read(&mut self, at: u64) -> &Raw {
        let raw = self.sampler.read(at);
        if let Some(c) = &raw.cpu {
            self.pct_1m = self.prev_cpu.and_then(|(t, u)| cpu_pct(t, u, at, c.usage_usec));
            self.prev_cpu = Some((at, c.usage_usec));
        } else {
            self.pct_1m = None;
        }
        self.raw = Some(raw);
        self.raw.as_ref().expect("just set")
    }

    /// The ring sample for the last reading, with the process's own fields filled.
    pub fn sample(&self) -> Sample {
        let Some(r) = &self.raw else { return Sample::default() };
        Sample {
            t: r.at,
            rss: r.rss,
            oom: r.oom_kills,
            cpu_usec: r.cpu.as_ref().map(|c| c.usage_usec),
            periods: r.cpu.as_ref().and_then(|c| c.nr_periods),
            throttled: r.cpu.as_ref().and_then(|c| c.nr_throttled),
            ..Sample::default()
        }
    }

    pub fn push(&mut self, s: Sample) {
        self.ring.push(s);
    }

    /// Memory and CPU as the tab shows them, from the last reading and the day's ring.
    pub fn figures(&self) -> (MemoryFigures, CpuFigures) {
        let Some(r) = &self.raw else { return (MemoryFigures { rss_source: "not read yet".into(), limit_source: "not read yet".into(), ..Default::default() }, CpuFigures::default()) };
        figures_from(r, &self.ring, self.pct_1m)
    }
}

/// Memory and CPU figures from one reading and the ring before it. Pure.
pub fn figures_from(r: &Raw, ring: &Ring, pct_1m: Option<f64>) -> (MemoryFigures, CpuFigures) {
    let used_pct = match (r.rss, r.limit) {
        (Some(u), Some(l)) if l > 0 => Some(u as f64 * 100.0 / l as f64),
        _ => None,
    };
    let mem = MemoryFigures {
        rss_bytes: r.rss,
        rss_source: r.rss_source.to_string(),
        limit_bytes: r.limit,
        limit_source: r.limit_source.to_string(),
        used_pct,
        peak_bytes_24h: ring.peak_rss(r.at, r.rss),
        hwm_bytes: r.hwm,
        oom_kills: r.oom_kills,
        oom_kills_24h: ring.oom_kills_24h(r.at, r.oom_kills),
    };
    let cpu = CpuFigures {
        readable: r.cpu.is_some(),
        pct_1m,
        limit_cpus: r.cpu_limit,
        pct_of_limit: match (pct_1m, r.cpu_limit) {
            (Some(p), Some(l)) if l > 0.0 => Some(p / l),
            _ => None,
        },
        throttled_pct_5m: ring.throttled_pct(r.at, 5 * MINUTE_MS, r.cpu.as_ref()),
        nr_periods: r.cpu.as_ref().and_then(|c| c.nr_periods),
        nr_throttled: r.cpu.as_ref().and_then(|c| c.nr_throttled),
        throttled_usec: r.cpu.as_ref().and_then(|c| c.throttled_usec),
    };
    (mem, cpu)
}

/* ---------------------------------------- message timing --------------------------------------- */

/// Bucket upper bounds, milliseconds. The last is everything slower.
pub const BUCKETS_MS: [u64; 16] = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, u64::MAX];
/// The minutes of timing kept: the 1-hour window.
pub const TIMING_MINUTES: usize = 60;
/// Distinct message types one minute keeps; past it they are counted as `(other)`, so a client
/// sending made-up types cannot grow the table.
pub const MAX_TYPES_PER_MINUTE: usize = 200;
pub const OTHER_TYPE: &str = "(other)";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hist {
    pub counts: [u32; 16],
    pub n: u64,
    pub errors: u64,
    pub max_ms: u64,
}

impl Hist {
    pub fn add(&mut self, ms: u64, ok: bool) {
        let i = BUCKETS_MS.iter().position(|b| ms <= *b).unwrap_or(BUCKETS_MS.len() - 1);
        self.counts[i] = self.counts[i].saturating_add(1);
        self.n += 1;
        if !ok {
            self.errors += 1;
        }
        self.max_ms = self.max_ms.max(ms);
    }

    pub fn merge(&mut self, o: &Hist) {
        for (a, b) in self.counts.iter_mut().zip(o.counts.iter()) {
            *a = a.saturating_add(*b);
        }
        self.n += o.n;
        self.errors += o.errors;
        self.max_ms = self.max_ms.max(o.max_ms);
    }

    /// The upper bound of the bucket holding the `p`-th percentile, never more than the slowest
    /// seen. `None` with nothing counted.
    pub fn percentile(&self, p: f64) -> Option<u64> {
        if self.n == 0 {
            return None;
        }
        let want = ((p * self.n as f64).ceil() as u64).clamp(1, self.n);
        let mut seen = 0u64;
        for (i, c) in self.counts.iter().enumerate() {
            seen += u64::from(*c);
            if seen >= want {
                return Some(BUCKETS_MS[i].min(self.max_ms));
            }
        }
        Some(self.max_ms)
    }
}

/// A message type as recorded: upper case, digits and `_`, at most 40 characters; anything
/// else is `(other)`.
fn type_key(t: &str) -> &str {
    if !t.is_empty() && t.len() <= 40 && t.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') {
        t
    } else {
        OTHER_TYPE
    }
}

/// Handling time per message type, by the minute, for the last hour.
#[derive(Debug, Default)]
pub struct MessageTimes {
    slots: VecDeque<(u64, HashMap<String, Hist>)>,
}

/// One message type over a window, as the tab shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeStats {
    #[serde(rename = "type")]
    pub kind: String,
    pub count: u64,
    pub errors: u64,
    pub p50_ms: Option<u64>,
    pub p95_ms: Option<u64>,
    pub p99_ms: Option<u64>,
    pub max_ms: Option<u64>,
}

impl TypeStats {
    fn of(kind: &str, h: &Hist) -> TypeStats {
        TypeStats {
            kind: kind.to_string(), count: h.n, errors: h.errors,
            p50_ms: h.percentile(0.50), p95_ms: h.percentile(0.95), p99_ms: h.percentile(0.99),
            max_ms: (h.n > 0).then_some(h.max_ms),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingWindow {
    pub minutes: u64,
    /// Every type together.
    pub all: TypeStats,
    /// Every type less [`WAITS_ELSEWHERE`]: what the p95 check reads.
    pub own: TypeStats,
    /// Most used first.
    pub by_type: Vec<TypeStats>,
}

impl MessageTimes {
    pub fn record(&mut self, t: &str, ms: u64, ok: bool, now_ms: u64) {
        let minute = now_ms / MINUTE_MS;
        if self.slots.back().is_none_or(|(m, _)| *m != minute) {
            self.slots.push_back((minute, HashMap::new()));
            while self.slots.len() > TIMING_MINUTES {
                self.slots.pop_front();
            }
        }
        let slot = &mut self.slots.back_mut().expect("just pushed").1;
        let mut key = type_key(t);
        if !slot.contains_key(key) && slot.len() >= MAX_TYPES_PER_MINUTE {
            key = OTHER_TYPE;
        }
        slot.entry(key.to_string()).or_default().add(ms, ok);
    }

    /// The last `minutes` (the current minute included), to `now_ms`.
    pub fn window(&self, minutes: u64, now_ms: u64) -> TimingWindow {
        let now_min = now_ms / MINUTE_MS;
        let mut per: HashMap<&str, Hist> = HashMap::new();
        for (m, slot) in &self.slots {
            if now_min.saturating_sub(*m) >= minutes || *m > now_min {
                continue;
            }
            for (k, h) in slot {
                per.entry(k.as_str()).or_default().merge(h);
            }
        }
        let (mut all, mut own) = (Hist::default(), Hist::default());
        for (k, h) in &per {
            all.merge(h);
            if !WAITS_ELSEWHERE.contains(k) {
                own.merge(h);
            }
        }
        let mut by_type: Vec<TypeStats> = per.iter().map(|(k, h)| TypeStats::of(k, h)).collect();
        by_type.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.kind.cmp(&b.kind)));
        TimingWindow { minutes, all: TypeStats::of("all", &all), own: TypeStats::of("own", &own), by_type }
    }
}

/// The five slowest types of a window by p95 (then p99), each with at least one message.
pub fn slowest(w: &TimingWindow, n: usize) -> Vec<TypeStats> {
    let mut v: Vec<TypeStats> = w.by_type.iter().filter(|t| t.count > 0).cloned().collect();
    v.sort_by(|a, b| b.p95_ms.cmp(&a.p95_ms).then_with(|| b.p99_ms.cmp(&a.p99_ms)).then_with(|| a.kind.cmp(&b.kind)));
    v.truncate(n);
    v
}

/* -------------------------------------------- gate -------------------------------------------- */

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClassGate {
    pub class: String,
    pub running: u64,
    pub waiting: u64,
    pub granted_5m: u64,
    pub wait_p95_ms: Option<u64>,
    pub overloaded_5m: u64,
    pub queue_timeout_5m: u64,
    pub overloaded_1h: Option<u64>,
    pub queue_timeout_1h: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClusterGate {
    pub cluster: String,
    pub running: u64,
    pub waiting: u64,
    /// Requests that went to the cluster in the last 5 min.
    pub sent_5m: u64,
    pub upstream_p95_ms: Option<u64>,
    pub timeouts_5m: u64,
    /// Answers `429 Too Many Requests` in the last 5 min: the cluster pushing back.
    pub rejected_5m: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GateFigures {
    /// `core` or `worker`.
    pub label: String,
    pub slots_in_use: u64,
    pub slots: u64,
    pub per_cluster: u64,
    pub per_jump: u64,
    pub background_reserve: u64,
    pub classes: Vec<ClassGate>,
    /// Busiest first; only clusters with something running, waiting or sent in 5 min.
    pub clusters: Vec<ClusterGate>,
}

/// One finished request, as the per-cluster figures read it (the Request Centre's record).
pub struct UpstreamRec<'a> {
    pub cluster: &'a str,
    pub at_ms: u64,
    pub ms: Option<u64>,
    pub status: Option<&'a str>,
    /// It reached the cluster (not shared, not from the read cache, not refused at the gate).
    pub sent: bool,
}

fn exact_percentile(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    Some(sorted[i.min(sorted.len() - 1)])
}

/// Per cluster: running and waiting now, and over the last 5 min of finished requests the
/// upstream p95, timeouts and 429s. Pure.
pub fn cluster_gate(recent: &[UpstreamRec<'_>], running: &HashMap<String, u64>, waiting: &HashMap<String, u64>, now_ms: u64) -> Vec<ClusterGate> {
    fn slot<'m>(by: &'m mut HashMap<String, (ClusterGate, Vec<u64>)>, c: &str) -> &'m mut (ClusterGate, Vec<u64>) {
        by.entry(c.to_string()).or_insert_with(|| (ClusterGate { cluster: c.to_string(), ..Default::default() }, vec![]))
    }
    let mut by: HashMap<String, (ClusterGate, Vec<u64>)> = HashMap::new();
    for (c, n) in running {
        slot(&mut by, c).0.running = *n;
    }
    for (c, n) in waiting {
        slot(&mut by, c).0.waiting = *n;
    }
    for r in recent.iter().filter(|r| r.sent && now_ms.saturating_sub(r.at_ms) <= 5 * MINUTE_MS) {
        let e = slot(&mut by, r.cluster);
        e.0.sent_5m += 1;
        match r.status {
            Some("timeout") => e.0.timeouts_5m += 1,
            Some("429") => e.0.rejected_5m += 1,
            _ => {}
        }
        if let Some(ms) = r.ms {
            e.1.push(ms);
        }
    }
    let mut out: Vec<ClusterGate> = by.into_values().map(|(mut g, mut ms)| {
        ms.sort_unstable();
        g.upstream_p95_ms = exact_percentile(&ms, 0.95);
        g
    }).collect();
    out.sort_by(|a, b| (b.waiting, b.running, b.timeouts_5m + b.rejected_5m, b.upstream_p95_ms)
        .cmp(&(a.waiting, a.running, a.timeouts_5m + a.rejected_5m, a.upstream_p95_ms))
        .then_with(|| a.cluster.cmp(&b.cluster)));
    out
}

/// The gate's figures for the tab: per class now and over 5 min (`Gate::load`/`Gate::window`,
/// the same functions the Request Centre's tiles read), the hour's refusals from the ring,
/// and per cluster from the finished requests. `visible` narrows the clusters.
pub fn gate_figures(label: &str, gate: &crate::gate::Gate, recent: &[UpstreamRec<'_>], hour: Option<(u64, u64)>,
                    visible: Option<&std::collections::HashSet<String>>) -> GateFigures {
    let lim = gate.limits();
    let load = gate.load();
    let w = gate.window(crate::gate::STATS_WINDOW_MS);
    let report = gate.report(visible);
    let counts = |k: &str| -> HashMap<String, u64> {
        report.get(k).and_then(Value::as_object)
            .map(|m| m.iter().map(|(c, n)| (c.clone(), n.as_u64().unwrap_or(0))).collect()).unwrap_or_default()
    };
    let classes = crate::gate::Class::ALL.iter().enumerate().map(|(i, c)| {
        let interactive = *c == crate::gate::Class::Interactive;
        ClassGate {
            class: c.as_str().to_string(),
            running: load.running[i] as u64,
            waiting: load.queued[i] as u64,
            granted_5m: w.granted[i] as u64,
            wait_p95_ms: w.wait_p95_ms[i],
            // Only a person's request is ever refused (gate.rs, "Bounded waiting, Interactive only").
            overloaded_5m: if interactive { w.overloaded as u64 } else { 0 },
            queue_timeout_5m: if interactive { w.queue_timeout as u64 } else { 0 },
            overloaded_1h: if interactive { hour.map(|h| h.0) } else { Some(0) },
            queue_timeout_1h: if interactive { hour.map(|h| h.1) } else { Some(0) },
        }
    }).collect();
    let sees = |c: &str| visible.is_none_or(|v| v.contains(c));
    let mine: Vec<UpstreamRec<'_>> = recent.iter().filter(|r| sees(r.cluster))
        .map(|r| UpstreamRec { cluster: r.cluster, at_ms: r.at_ms, ms: r.ms, status: r.status, sent: r.sent }).collect();
    GateFigures {
        label: label.to_string(),
        slots_in_use: load.running.iter().sum::<usize>() as u64,
        slots: lim.global as u64,
        per_cluster: lim.per_cluster as u64,
        per_jump: lim.per_jump as u64,
        background_reserve: lim.background_reserve as u64,
        classes,
        clusters: cluster_gate(&mine, &counts("runningByCluster"), &counts("queuedByCluster"), crate::fleet::now_ms()),
    }
}

/* ------------------------------------------- poller ------------------------------------------- */

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PollerFigures {
    pub enabled: bool,
    pub stopped: bool,
    pub clusters: u64,
    pub down: u64,
    /// Scheduled datasets on clusters that answer and are not held back.
    pub tracked: u64,
    pub due: u64,
    pub late: u64,
    pub late_pct: Option<f64>,
    pub late_by_max_ms: Option<u64>,
    /// How long the poller's last pass took, and its p95 over the last 5 min.
    pub cycle_ms: Option<u64>,
    pub cycle_p95_ms: Option<u64>,
}

/// `(tracked, due, late, most late by)` from each counted dataset's next due time. Pure.
pub fn lateness(next_due: &[Option<u64>], now: u64) -> (u64, u64, u64, Option<u64>) {
    let (mut due, mut late, mut by) = (0u64, 0u64, None::<u64>);
    for d in next_due.iter().flatten() {
        if *d <= now {
            due += 1;
            let over = now - d;
            if over > LATE_AFTER_MS {
                late += 1;
                by = Some(by.map_or(over, |b| b.max(over)));
            }
        }
    }
    (next_due.len() as u64, due, late, by)
}

/* -------------------------------------------- disk -------------------------------------------- */

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Area {
    pub id: String,
    pub label: String,
    pub bytes: Option<u64>,
    pub files: Option<u64>,
    /// The walk stopped at [`WALK_CAP`]: `bytes` is at least this.
    pub at_least: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiskFigures {
    pub path: Option<String>,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub free_pct: Option<f64>,
    pub areas: Vec<Area>,
    /// When the areas were last measured (they are walked every ten minutes).
    pub areas_at: Option<u64>,
}

/// The volume's space now. Pure apart from `statvfs`.
pub fn disk_space(data: &Path) -> DiskFigures {
    let mut d = DiskFigures { path: Some(data.display().to_string()), ..Default::default() };
    if let Some((total, free)) = statvfs(data) {
        d.total_bytes = Some(total);
        d.free_bytes = Some(free);
        d.used_bytes = Some(total.saturating_sub(free));
        d.free_pct = (total > 0).then(|| free as f64 * 100.0 / total as f64);
    }
    d
}

/// The size of each area of the data directory: the volume record (less the host files), the
/// host files, report files, the fleet cache and the logs.
pub fn disk_areas(data: &Path) -> Vec<Area> {
    let walk = |p: &Path| dir_size(p, WALK_CAP);
    let (vol, vol_files, vol_cut) = walk(&data.join("volume"));
    let (mut hosts, mut host_files, mut hosts_cut) = (0u64, 0u64, false);
    if let Ok(rd) = std::fs::read_dir(data.join("volume")) {
        for e in rd.flatten() {
            let (b, f, cut) = walk(&e.path().join("hosts"));
            hosts += b;
            host_files += f;
            hosts_cut |= cut;
        }
    }
    let area = |id: &str, label: &str, (bytes, files, cut): (u64, u64, bool)| Area {
        id: id.into(), label: label.into(), bytes: Some(bytes), files: Some(files), at_least: cut,
    };
    let mut logs = (0u64, 0u64, false);
    if let Ok(rd) = std::fs::read_dir(data) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("activity") {
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        logs.0 += m.len();
                        logs.1 += 1;
                    }
                }
            }
        }
    }
    if let Ok(m) = std::fs::metadata(data.join("worker").join("requests.jsonl")) {
        logs.0 += m.len();
        logs.1 += 1;
    }
    vec![
        area("volume", "Volume record", (vol.saturating_sub(hosts), vol_files.saturating_sub(host_files), vol_cut)),
        area("hosts", "Host files", (hosts, host_files, hosts_cut)),
        area("reports", "Report files", walk(&data.join("reports"))),
        area("cache", "Fleet cache", walk(&data.join("cache"))),
        area("logs", "Logs (activity, worker requests)", logs),
    ]
}

/* ------------------------------------ reports and the worker ----------------------------------- */

/// `{done, total}`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Count {
    pub done: u64,
    pub total: u64,
}

/// One report job as section 7 shows it. Read leniently from a job of `jobs.json` (or the
/// worker's status file): `progress`, and when the job carries them (docs/REPORT-TYPES.md
/// "Concurrency") `day`, `partitions`, `pages`, `rows`, `concurrency`, `halvings`, `lastReason`
/// — on the job or inside its `progress`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobLine {
    pub id: String,
    /// `cluster` / `mailed` (volume), or the job's `reportKind` (`indices`, `hosts`) when it has one.
    pub kind: String,
    pub cluster_id: String,
    pub cluster_name: String,
    pub by: String,
    pub status: String,
    pub created_at: Option<i64>,
    pub started_at: Option<i64>,
    pub progress: Count,
    pub day: Option<String>,
    pub partitions: Option<Count>,
    pub pages: Option<u64>,
    pub rows: Option<u64>,
    pub concurrency: Option<u64>,
    pub halvings: Option<u64>,
    pub last_reason: Option<String>,
}

fn count_of(v: Option<&Value>) -> Option<Count> {
    let v = v?;
    if let Some(n) = v.as_u64() {
        return Some(Count { done: n, total: 0 });
    }
    Some(Count { done: v.get("done")?.as_u64()?, total: v.get("total").and_then(Value::as_u64).unwrap_or(0) })
}

/// A job of `jobs.json`, leniently.
pub fn job_line(j: &Value) -> JobLine {
    let s = |k: &str| j.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let p = j.get("progress");
    let pick = |k: &str| j.get(k).filter(|v| !v.is_null()).or_else(|| p.and_then(|p| p.get(k)).filter(|v| !v.is_null()));
    JobLine {
        id: s("id"),
        kind: j.get("reportKind").and_then(Value::as_str).map(String::from).unwrap_or_else(|| s("kind")),
        cluster_id: s("clusterId"),
        cluster_name: s("clusterName"),
        by: s("by"),
        status: s("status"),
        created_at: j.get("createdAt").and_then(Value::as_i64),
        started_at: j.get("startedAt").and_then(Value::as_i64),
        progress: count_of(p).unwrap_or_default(),
        day: pick("day").and_then(Value::as_str).map(String::from),
        partitions: count_of(pick("partitions")),
        pages: pick("pages").and_then(Value::as_u64),
        rows: pick("rows").and_then(Value::as_u64),
        concurrency: pick("concurrency").and_then(Value::as_u64),
        halvings: pick("halvings").and_then(Value::as_u64),
        last_reason: pick("lastReason").and_then(Value::as_str).map(String::from),
    }
}

/// Running jobs (in the order they started) and queued ones (in the order asked) from a queue
/// (`jobs.json`'s shape).
pub fn jobs_from(queue: &Value) -> (Vec<JobLine>, Vec<JobLine>) {
    let all: Vec<JobLine> = queue.get("jobs").and_then(Value::as_array).map(|a| a.iter().map(job_line).collect()).unwrap_or_default();
    let mut running: Vec<JobLine> = all.iter().filter(|j| j.status == "running").cloned().collect();
    running.sort_by_key(|j| j.started_at);
    let mut queued: Vec<JobLine> = all.into_iter().filter(|j| j.status == "queued").collect();
    queued.sort_by_key(|j| j.created_at);
    (running, queued)
}

/// A collection in progress (the daily volume run, the 06:00 host collection).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionLine {
    pub cluster_id: String,
    /// `volume` or `hosts`.
    pub kind: String,
    pub progress: Count,
    pub concurrency: Option<u64>,
}

/// What the report worker writes to `<data>/worker/status.json` every [`WORKER_HEARTBEAT_SECS`]
/// (temp file + rename), and the core reads for the health tab. Every field is optional on
/// read (`#[serde(default)]`), so a worker and core one release apart still agree as far as
/// they can. Documented in docs/HEALTH.md, "The worker's status file".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkerStatus {
    /// [`WORKER_STATUS_SCHEMA`].
    pub schema: u32,
    /// `worker`.
    pub role: String,
    /// The worker's `crate::VERSION`; a different one from the core's is a red check.
    pub version: String,
    pub pid: Option<u32>,
    /// Unix ms.
    pub started_at: u64,
    /// Unix ms of this write.
    pub heartbeat_at: u64,
    /// From the worker's own [`SelfMonitor::figures`].
    pub memory: MemoryFigures,
    pub cpu: CpuFigures,
    /// From [`gate_figures`] on the worker's own gate, labelled `worker`.
    pub gate: Option<GateFigures>,
    /// Running report jobs, with progress and concurrency ([`job_line`] of each).
    pub jobs: Vec<JobLine>,
    /// Report jobs waiting.
    pub queued: u64,
    /// Collections in progress.
    pub collection: Vec<CollectionLine>,
}

impl WorkerStatus {
    pub fn path(data: &Path) -> PathBuf {
        data.join(WORKER_STATUS_FILE)
    }

    /// `Ok(None)`: no file (no worker has ever run here). A file mid-rename is read again once.
    pub fn read(data: &Path) -> Result<Option<WorkerStatus>, String> {
        let p = WorkerStatus::path(data);
        for attempt in 0..2 {
            match std::fs::read(&p) {
                Ok(b) => match serde_json::from_slice::<WorkerStatus>(&b) {
                    Ok(s) => return Ok(Some(s)),
                    Err(e) if attempt == 1 => return Err(format!("{}: {e}", p.display())),
                    Err(_) => continue,
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) if attempt == 1 => return Err(format!("{}: {e}", p.display())),
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    /// Write it (temp file + rename, 0600), as the worker does every heartbeat.
    pub fn write(&self, data: &Path) -> Result<(), String> {
        let body = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        crate::volume::store::write_atomic(&WorkerStatus::path(data), &body)
    }

    /// The reports' concurrency, all running jobs together (the trend line).
    pub fn concurrency(&self) -> Option<u64> {
        let v: Vec<u64> = self.jobs.iter().filter_map(|j| j.concurrency).chain(self.collection.iter().filter_map(|c| c.concurrency)).collect();
        (!v.is_empty()).then(|| v.iter().sum())
    }
}

/// `ELASTICPRO_ROLE` as docs/WORKER.md defines it: `core`, `worker`, else `all`.
pub fn role_from(v: Option<&str>) -> &'static str {
    match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("core") => "core",
        Some("worker") => "worker",
        _ => "all",
    }
}

pub fn role() -> &'static str {
    role_from(std::env::var("ELASTICPRO_ROLE").ok().as_deref())
}

/// The worker as the tab shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerView {
    /// `not_deployed` (role all: there is no worker), `missing` (role core, no status file),
    /// `unreadable`, `up`, `late` (heartbeat ≥ amber), `down` (≥ red), `version` (mismatch).
    pub state: String,
    pub level: Level,
    pub text: String,
    pub heartbeat_age_secs: Option<u64>,
    pub version_match: Option<bool>,
    pub status: Option<WorkerStatus>,
}

/// Pure: the worker's state from the role, what its status file said and the clock.
pub fn worker_view(role: &str, file: Result<Option<WorkerStatus>, String>, now_ms: u64, core_version: &str) -> WorkerView {
    if role == "all" {
        return WorkerView { state: "not_deployed".into(), level: Level::Off,
            text: "not deployed — role all: this container runs reports and collection itself".into(), ..Default::default() };
    }
    let st = match file {
        Ok(Some(s)) => s,
        Ok(None) => return WorkerView { state: "missing".into(), level: Level::Bad,
            text: "the report worker has never written its status (worker/status.json)".into(), ..Default::default() },
        Err(e) => return WorkerView { state: "unreadable".into(), level: Level::Unknown, text: format!("not known — {e}"), ..Default::default() },
    };
    let age = now_ms.saturating_sub(st.heartbeat_at) / 1000;
    let matches = st.version == core_version;
    let (state, level, text) = if !matches {
        ("version", Level::Bad, format!("version {} — the core is {core_version}", if st.version.is_empty() { "not known" } else { &st.version }))
    } else if age >= HEARTBEAT_RED_SECS {
        ("down", Level::Bad, format!("no heartbeat for {}", secs_text(age)))
    } else if age >= HEARTBEAT_AMBER_SECS {
        ("late", Level::Warn, format!("heartbeat {} ago", secs_text(age)))
    } else {
        ("up", Level::Ok, format!("up · heartbeat {} ago · {}", secs_text(age), st.version))
    };
    WorkerView { state: state.into(), level, text, heartbeat_age_secs: Some(age), version_match: Some(matches), status: Some(st) }
}

/* ------------------------------------------- checks ------------------------------------------- */

/// One line of the checks: what it measured, how it stands, what it means and what fixes it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    /// `memory`, `cpu`, `messages`, `gate`, `poller`, `worker`, `disk` — the [`THRESHOLDS`] id.
    pub threshold: String,
    pub label: String,
    pub level: Level,
    pub value: String,
    pub text: String,
    pub fix: Option<String>,
}

pub struct CheckInputs<'a> {
    pub core_mem: &'a MemoryFigures,
    pub core_cpu: &'a CpuFigures,
    /// `None` when there is no worker (role all) — its checks are left out, not unknown.
    pub worker: &'a WorkerView,
    pub message_p95_ms: Option<u64>,
    pub message_count: u64,
    pub refused_5m: Option<u64>,
    pub poller: Option<&'a PollerFigures>,
    pub disk: Option<&'a DiskFigures>,
}

pub fn bytes_text(b: u64) -> String {
    const K: f64 = 1024.0;
    let f = b as f64;
    if f >= K * K * K {
        format!("{:.1} GiB", f / (K * K * K))
    } else if f >= K * K {
        format!("{:.0} MiB", f / (K * K))
    } else if f >= K {
        format!("{:.0} KiB", f / K)
    } else {
        format!("{b} B")
    }
}

pub fn secs_text(s: u64) -> String {
    if s >= 3600 {
        format!("{} h {} min", s / 3600, (s % 3600) / 60)
    } else if s >= 60 {
        format!("{} min {} s", s / 60, s % 60)
    } else {
        format!("{s} s")
    }
}

fn ms_text(ms: u64) -> String {
    if ms >= 1000 { format!("{:.1} s", ms as f64 / 1000.0) } else { format!("{ms} ms") }
}

fn memory_check(who: &str, id: &str, m: &MemoryFigures, fix: &str) -> Check {
    let label = format!("{who} memory of limit");
    let base = Check { id: id.into(), threshold: "memory".into(), label, ..Default::default() };
    let oom = m.oom_kills_24h.unwrap_or(0);
    let Some(rss) = m.rss_bytes else {
        return Check { level: Level::Unknown, value: "not known".into(), text: format!("{who} resident memory cannot be read here (no cgroup or /proc)."), ..base };
    };
    let Some(limit) = m.limit_bytes else {
        let level = if oom > 0 { Level::Bad } else { Level::Ok };
        return Check { level, value: format!("{} · no limit", bytes_text(rss)),
            text: if oom > 0 { format!("{oom} OOM kill(s) in the last 24 h.") } else { format!("{who} has no memory limit: nothing to compare against.") },
            fix: (oom > 0).then(|| fix.to_string()), ..base };
    };
    let pct = m.used_pct.unwrap_or(rss as f64 * 100.0 / limit.max(1) as f64);
    let mut level = Level::of_high(pct, MEM_AMBER_PCT, MEM_RED_PCT);
    if oom > 0 {
        level = Level::Bad;
    }
    let value = format!("{:.0}% · {} of {}", pct, bytes_text(rss), bytes_text(limit));
    let text = match level {
        Level::Bad if oom > 0 => format!("{who} was OOM-killed {oom} time(s) in the last 24 h: the kernel ended it for using its whole limit."),
        Level::Bad => format!("{who} is at {pct:.0}% of its memory limit: close to being OOM-killed."),
        Level::Warn => format!("{who} is at {pct:.0}% of its memory limit."),
        _ => format!("{who} memory is within its limit."),
    };
    Check { level, value, text, fix: (level.rank() > 0).then(|| fix.to_string()), ..base }
}

fn cpu_check(who: &str, id: &str, c: &CpuFigures, fix: &str) -> Check {
    let base = Check { id: id.into(), threshold: "cpu".into(), label: format!("{who} CPU throttled"), ..Default::default() };
    let Some(t) = c.throttled_pct_5m else {
        let (level, value, text) = if !c.readable {
            (Level::Unknown, "not known".to_string(), format!("{who} CPU cannot be read here (no cgroup cpu.stat)."))
        } else if c.nr_periods.is_none() {
            (Level::Ok, "no CPU limit".to_string(), format!("{who} has no CPU limit, so it is never throttled."))
        } else {
            (Level::Unknown, "not known yet".to_string(), "Needs two readings a few minutes apart.".to_string())
        };
        return Check { level, value, text, ..base };
    };
    let level = Level::of_high(t, THROTTLE_AMBER_PCT, THROTTLE_RED_PCT);
    let text = if level.rank() > 0 {
        format!("{who} was held back by its CPU limit in {t:.0}% of periods over 5 min: everything it does is slower.")
    } else {
        format!("{who} is rarely held back by its CPU limit.")
    };
    Check { level, value: format!("{t:.0}% of periods"), text, fix: (level.rank() > 0).then(|| fix.to_string()), ..base }
}

/// The checks of docs/HEALTH.md, in its order. Pure.
pub fn evaluate(i: &CheckInputs<'_>) -> Vec<Check> {
    let mut out = vec![
        memory_check("Core", "core.memory", i.core_mem,
            "Raise CORE_MEM_LIMIT in config.txt (ELASTICPRO_MEM_LIMIT in deploy/.env) and redeploy; or lower ELASTICPRO_CACHE_MB."),
    ];
    let worker_up = i.worker.status.is_some();
    if let (true, Some(st)) = (worker_up, &i.worker.status) {
        out.push(memory_check("Worker", "worker.memory", &st.memory,
            "Raise ELASTICPRO_WORKER_MEM_LIMIT in deploy/.env, or lower UI_REPORT_CONCURRENCY_MAX so fewer report requests are open at once."));
    }
    out.push(cpu_check("Core", "core.cpu", i.core_cpu, "Give the core more CPU (cpus: in deploy/docker-compose.yml), or lower ES_CONCURRENCY in config.txt."));
    if let (true, Some(st)) = (worker_up, &i.worker.status) {
        out.push(cpu_check("Worker", "worker.cpu", &st.cpu, "Raise ELASTICPRO_WORKER_CPUS in deploy/.env, or lower UI_REPORT_CONCURRENCY_MAX."));
    }
    // Messages.
    out.push(match i.message_p95_ms {
        None => Check { id: "messages.p95".into(), threshold: "messages".into(), label: "Message p95 (5 min)".into(), level: Level::Ok,
            value: "no messages".into(), text: "Nothing asked of the core in the last 5 minutes.".into(), fix: None },
        Some(p) => {
            let level = if p >= P95_RED_MS { Level::Bad } else if p >= P95_AMBER_MS { Level::Warn } else { Level::Ok };
            Check { id: "messages.p95".into(), threshold: "messages".into(), label: "Message p95 (5 min)".into(), level,
                value: format!("{} over {} messages", ms_text(p), i.message_count),
                text: if level.rank() > 0 { "The core itself is slow to answer (messages that wait on a cluster, Zabbix or mail are not counted here). Look at the slowest types below, and at memory and CPU first.".into() }
                      else { "The core answers quickly.".into() },
                fix: (level.rank() > 0).then(|| "If CPU is throttled or memory near its limit, fix that first; otherwise lower ES_CONCURRENCY or the poller's concurrency (Config › Requests).".into()) }
        }
    });
    // Gate.
    out.push(match i.refused_5m {
        None => Check { id: "gate.refused".into(), threshold: "gate".into(), label: "Requests turned away (5 min)".into(), level: Level::Unknown,
            value: "not known".into(), text: "The gate does not report its refusals.".into(), fix: None },
        Some(n) => {
            let level = if n >= REFUSED_RED { Level::Bad } else if n >= REFUSED_AMBER { Level::Warn } else { Level::Ok };
            Check { id: "gate.refused".into(), threshold: "gate".into(), label: "Requests turned away (5 min)".into(), level,
                value: n.to_string(),
                text: if n > 0 { format!("{n} request(s) from people were refused by the gate (queue full or waited too long) in 5 min.") } else { "Nobody's request was turned away.".into() },
                fix: (n > 0).then(|| "Raise ES_QUEUE_MAX / ES_QUEUE_WAIT_MS in config.txt, or ES_CONCURRENCY if the clusters can take it; a page fanning out over many clusters is the usual cause.".into()) }
        }
    });
    // Poller.
    out.push(match i.poller {
        Some(p) if p.enabled && !p.stopped => match p.late_pct {
            Some(pct) => {
                let level = Level::of_high(pct, LATE_AMBER_PCT, LATE_RED_PCT);
                Check { id: "poller.late".into(), threshold: "poller".into(), label: "Poller late datasets".into(), level,
                    value: format!("{pct:.0}% · {} of {}", p.late, p.tracked),
                    text: if level.rank() > 0 { format!("{} scheduled dataset(s) are more than {} s past due{}.", p.late, LATE_AFTER_MS / 1000,
                        p.late_by_max_ms.map(|m| format!(", the worst by {}", secs_text(m / 1000))).unwrap_or_default()) }
                          else { "The poller keeps up with its schedule.".into() },
                    fix: (level.rank() > 0).then(|| "The poller is behind: raise its concurrency (Config › Requests) or ES_CONCURRENCY, or lengthen the intervals; a CPU-throttled core is also behind.".into()) }
            }
            None => Check { id: "poller.late".into(), threshold: "poller".into(), label: "Poller late datasets".into(), level: Level::Ok,
                value: "nothing scheduled".into(), text: "No scheduled dataset on a cluster that answers.".into(), fix: None },
        },
        Some(p) if p.stopped => Check { id: "poller.late".into(), threshold: "poller".into(), label: "Poller late datasets".into(), level: Level::Off,
            value: "emergency stop".into(), text: "The emergency stop holds the poller; nothing is late on purpose.".into(), fix: None },
        _ => Check { id: "poller.late".into(), threshold: "poller".into(), label: "Poller late datasets".into(), level: Level::Off,
            value: "not running".into(), text: "The fleet poller is not running in this process.".into(), fix: None },
    });
    // Worker.
    let wfix = |state: &str| match state {
        "version" => "Run the same image for core and worker: deploy/upgrade (or docker compose pull && docker compose up -d).",
        _ => "docker compose ps worker; docker compose logs --tail 100 worker; docker compose up -d worker. Monitoring is not affected.",
    };
    out.push(Check { id: "worker.heartbeat".into(), threshold: "worker".into(), label: "Report worker".into(), level: i.worker.level,
        value: match i.worker.heartbeat_age_secs { Some(a) => format!("{} ago", secs_text(a)), None => i.worker.state.replace('_', " ") },
        text: i.worker.text.clone(),
        fix: (i.worker.level.rank() > 0).then(|| wfix(&i.worker.state).to_string()) });
    // Disk.
    out.push(match i.disk.and_then(|d| d.free_pct.map(|p| (d, p))) {
        Some((d, pct)) => {
            let level = if pct <= DISK_FREE_RED_PCT { Level::Bad } else if pct <= DISK_FREE_AMBER_PCT { Level::Warn } else { Level::Ok };
            Check { id: "disk.free".into(), threshold: "disk".into(), label: "Data volume free".into(), level,
                value: format!("{pct:.0}% · {} free", d.free_bytes.map(bytes_text).unwrap_or_else(|| "not known".into())),
                text: if level.rank() > 0 { format!("The data volume has {pct:.0}% free; a full volume stops the record, reports and the cache being written.") }
                      else { "Plenty of room on the data volume.".into() },
                fix: (level.rank() > 0).then(|| "Run Housekeeping now (Request Centre), check the largest area below, or grow the volume.".into()) }
        }
        None => Check { id: "disk.free".into(), threshold: "disk".into(), label: "Data volume free".into(), level: Level::Unknown,
            value: "not known".into(), text: "The data volume's space cannot be read (no data directory, or no statvfs).".into(), fix: None },
    });
    out
}

/* -------------------------------------- report schedules --------------------------------------- */

/// One kind's schedule, as section 7 shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleLine {
    pub kind: String,
    pub enabled: bool,
    pub cadence: Option<String>,
    pub at: Option<String>,
    pub recipients: u64,
    /// Server local time, `YYYY-MM-DD HH:MM`; `None` when it will not send.
    pub next_at: Option<String>,
    /// The schedule's last send: `{at, to, ok, error}` as `report-schedule.json` keeps it.
    pub last_sent: Option<Value>,
}

/// The kinds of `report-schedule.json`: `{volume, indices, hosts}` per docs/REPORT-TYPES.md, or
/// the old single object, which is `volume`. `state` is `report-schedule-state.json` when the
/// worker keeps the last sends apart (docs/WORKER.md); a kind's `lastSent` there wins.
pub fn schedules_from(file: &Value, state: Option<&Value>, clock: crate::report::schedule::Clock) -> Vec<ScheduleLine> {
    const KINDS: [&str; 3] = ["volume", "indices", "hosts"];
    let per_kind = KINDS.iter().any(|k| file.get(*k).is_some_and(Value::is_object));
    let objs: Vec<(&str, &Value)> = if per_kind {
        KINDS.iter().filter_map(|k| file.get(*k).filter(|v| v.is_object()).map(|v| (*k, v))).collect()
    } else if file.is_object() {
        vec![("volume", file)]
    } else {
        vec![]
    };
    objs.into_iter().map(|(kind, o)| {
        let next_at = serde_json::from_value::<crate::report::schedule::ReportSchedule>(o.clone()).ok()
            .and_then(|s| crate::report::schedule::next_send(&s, clock))
            .map(|t| t.format("%Y-%m-%d %H:%M").to_string());
        let last_sent = state.and_then(|s| s.get(kind)).and_then(|k| k.get("lastSent")).filter(|v| !v.is_null())
            .or_else(|| o.get("lastSent").filter(|v| !v.is_null())).cloned();
        ScheduleLine {
            kind: kind.to_string(),
            enabled: o.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            cadence: o.get("schedule").and_then(Value::as_str).map(String::from),
            at: o.get("at").and_then(Value::as_str).map(String::from),
            recipients: o.get("to").and_then(Value::as_array).map(|a| a.len() as u64).unwrap_or(0),
            next_at,
            last_sent,
        }
    }).collect()
}

/* ------------------------------------- what the core holds ------------------------------------- */

/// Figures the minute task gathers that would cost I/O to read on every 5-s poll.
#[derive(Clone, Debug, Default)]
pub struct Held {
    pub disk: Option<DiskFigures>,
    pub schedules: Vec<ScheduleLine>,
    /// Whether mail is configured enough to send.
    pub mail_configured: Option<bool>,
    pub checks: Vec<Check>,
}

/// The core's (or worker's) health state: message timing, the self monitor and its ring, the
/// poller's pass times, and the level `PING` reports. Recording a message is one short lock;
/// nothing here is on the request gate's path.
pub struct Health {
    pub times: parking_lot::Mutex<MessageTimes>,
    pub monitor: parking_lot::Mutex<SelfMonitor>,
    /// `(at, ms)` of the poller's passes in the last 5 min.
    ticks: parking_lot::Mutex<VecDeque<(u64, u64)>>,
    pub held: parking_lot::RwLock<Held>,
    level: std::sync::atomic::AtomicU8,
    pub role: &'static str,
    pub started_at: u64,
    pub samples: std::sync::atomic::AtomicU64,
    pub started: std::sync::atomic::AtomicBool,
    pub data: Option<PathBuf>,
}

impl Health {
    /// The ring is loaded from `<data>/health/<role>.json`, so a restart keeps the day.
    pub fn new(data: Option<&Path>, sampler: Sampler) -> Health {
        let role = role();
        let now = crate::fleet::now_ms();
        let ring = data.map(|d| Ring::load(d, role, now)).unwrap_or_default();
        Health {
            times: Default::default(),
            monitor: parking_lot::Mutex::new(SelfMonitor::new(sampler, ring)),
            ticks: Default::default(),
            held: Default::default(),
            level: std::sync::atomic::AtomicU8::new(0),
            role,
            started_at: now,
            samples: Default::default(),
            started: Default::default(),
            data: data.map(Path::to_path_buf),
        }
    }

    /// One message handled: its type, how long, whether it answered `ok`.
    pub fn record(&self, kind: &str, ms: u64, ok: bool) {
        self.times.lock().record(kind, ms, ok, crate::fleet::now_ms());
    }

    /// One pass of the fleet poller took `ms`.
    pub fn note_tick(&self, ms: u64) {
        let now = crate::fleet::now_ms();
        let mut t = self.ticks.lock();
        t.push_back((now, ms));
        while t.front().is_some_and(|f| now.saturating_sub(f.0) > 5 * MINUTE_MS) || t.len() > 2_000 {
            t.pop_front();
        }
    }

    /// The last pass, and the p95 of the last 5 min.
    pub fn cycle(&self) -> (Option<u64>, Option<u64>) {
        let t = self.ticks.lock();
        let last = t.back().map(|x| x.1);
        let mut v: Vec<u64> = t.iter().map(|x| x.1).collect();
        drop(t);
        v.sort_unstable();
        (last, exact_percentile(&v, 0.95))
    }

    pub fn level(&self) -> Level {
        match self.level.load(std::sync::atomic::Ordering::Relaxed) {
            1 => Level::Warn,
            2 => Level::Bad,
            _ => Level::Ok,
        }
    }

    pub fn set_level(&self, l: Level) {
        self.level.store(l.rank(), std::sync::atomic::Ordering::Relaxed);
    }
}

/* -------------------------------------------- tests -------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    struct Fx(PathBuf);
    impl Fx {
        fn new(name: &str) -> Fx {
            let d = std::env::temp_dir().join(format!("ep-health-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Fx(d)
        }
        fn put(&self, name: &str, body: &str) {
            let p = self.0.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        fn sampler(&self) -> Sampler {
            Sampler { cgroup: self.0.join("cg"), proc_status: self.0.join("status") }
        }
    }
    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_v2_cgroup_is_read_as_docker_stats_counts_it() {
        let fx = Fx::new("v2");
        fx.put("cg/memory.current", "943718400\n");
        fx.put("cg/memory.stat", "anon 800000000\nfile 143718400\ninactive_file 104857600\nactive_file 1000\n");
        fx.put("cg/memory.max", "1073741824\n");
        fx.put("cg/memory.events", "low 0\nhigh 0\nmax 12\noom 2\noom_kill 1\noom_group_kill 0\n");
        fx.put("cg/cpu.stat", "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\nnr_periods 100\nnr_throttled 7\nthrottled_usec 350000\n");
        fx.put("cg/cpu.max", "150000 100000\n");
        fx.put("status", "Name:\tbridge\nVmHWM:\t  204800 kB\nVmRSS:\t  102400 kB\n");
        let r = fx.sampler().read(1_000);
        assert_eq!(r.rss, Some(943_718_400 - 104_857_600));
        assert_eq!(r.rss_source, "cgroup memory.current less inactive_file");
        assert_eq!((r.limit, r.limit_source), (Some(1024 * MIB), "cgroup v2"));
        assert_eq!(r.oom_kills, Some(1));
        assert_eq!(r.hwm, Some(200 * MIB));
        assert_eq!(r.cpu, Some(CpuStat { usage_usec: 5_000_000, nr_periods: Some(100), nr_throttled: Some(7), throttled_usec: Some(350_000) }));
        assert_eq!(r.cpu_limit, Some(1.5));
    }

    #[test]
    fn no_cgroup_falls_back_to_proc_and_nothing_at_all_is_not_known() {
        let fx = Fx::new("absent");
        fx.put("status", "VmRSS:\t  102400 kB\nVmHWM:\t  204800 kB\n");
        let r = fx.sampler().read(1);
        assert_eq!((r.rss, r.rss_source), (Some(100 * MIB), "/proc/self/status VmRSS"));
        assert_eq!((r.limit, r.limit_source), (None, "none"));
        assert_eq!((r.oom_kills, r.cpu.clone(), r.cpu_limit), (None, None, None));
        // macOS: neither.
        let none = Sampler { cgroup: fx.0.join("nope"), proc_status: fx.0.join("nope") }.read(1);
        assert_eq!((none.rss, none.rss_source), (None, "not known"));
        let (m, c) = figures_from(&none, &Ring::default(), None);
        assert_eq!(m.used_pct, None);
        let checks = evaluate(&CheckInputs { core_mem: &m, core_cpu: &c, worker: &worker_view("all", Ok(None), 0, "x"),
            message_p95_ms: None, message_count: 0, refused_5m: Some(0), poller: None, disk: None });
        let mem = checks.iter().find(|c| c.id == "core.memory").unwrap();
        assert_eq!(mem.level, Level::Unknown, "never green when it cannot be read");
        assert_eq!(checks.iter().find(|c| c.id == "disk.free").unwrap().level, Level::Unknown);
    }

    #[test]
    fn max_means_no_limit() {
        let fx = Fx::new("max");
        fx.put("cg/memory.current", "1048576\n");
        fx.put("cg/memory.max", "max\n");
        fx.put("cg/cpu.max", "max 100000\n");
        fx.put("cg/cpu.stat", "usage_usec 10\nuser_usec 5\nsystem_usec 5\n");
        let r = fx.sampler().read(1);
        assert_eq!((r.limit, r.limit_source), (None, "none"));
        assert_eq!(r.cpu_limit, None);
        assert_eq!(r.cpu.as_ref().and_then(|c| c.nr_periods), None);
        let (m, c) = figures_from(&r, &Ring::default(), None);
        let checks = evaluate(&CheckInputs { core_mem: &m, core_cpu: &c, worker: &worker_view("all", Ok(None), 0, "x"),
            message_p95_ms: None, message_count: 0, refused_5m: Some(0), poller: None, disk: None });
        let mem = checks.iter().find(|c| c.id == "core.memory").unwrap();
        assert_eq!((mem.level, mem.value.as_str()), (Level::Ok, "1 MiB · no limit"));
        let cpu = checks.iter().find(|c| c.id == "core.cpu").unwrap();
        assert_eq!((cpu.level, cpu.value.as_str()), (Level::Ok, "no CPU limit"));
    }

    #[test]
    fn histogram_percentiles_are_bucket_bounds_capped_at_the_slowest() {
        let mut h = Hist::default();
        assert_eq!(h.percentile(0.5), None);
        for _ in 0..90 { h.add(3, true); }
        for _ in 0..9 { h.add(400, true); }
        h.add(7_000, false);
        assert_eq!(h.n, 100);
        assert_eq!(h.errors, 1);
        assert_eq!(h.percentile(0.50), Some(5));
        assert_eq!(h.percentile(0.95), Some(500));
        assert_eq!(h.percentile(0.99), Some(500));
        assert_eq!(h.percentile(1.0), Some(7_000), "the last bucket is capped at the slowest seen");
        let mut one = Hist::default();
        one.add(70_000, true);
        assert_eq!(one.percentile(0.5), Some(70_000));
    }

    #[test]
    fn message_times_keep_an_hour_by_minute_and_bound_the_types() {
        let mut t = MessageTimes::default();
        let m0 = 1_000 * MINUTE_MS;
        t.record("PING", 2, true, m0);
        t.record("ES", 9_000, true, m0 + 1);
        t.record("FLEET_STATE", 30, false, m0 + 2 * MINUTE_MS);
        let w5 = t.window(5, m0 + 2 * MINUTE_MS);
        assert_eq!(w5.all.count, 3);
        assert_eq!(w5.own.count, 2, "ES waits on a cluster and is left out of the check's figure");
        assert_eq!(w5.own.p95_ms, Some(30), "the 50 ms bucket, capped at the slowest seen");
        assert_eq!(w5.by_type.iter().find(|x| x.kind == "FLEET_STATE").unwrap().errors, 1);
        assert_eq!(slowest(&w5, 1)[0].kind, "ES");
        // Ten minutes on: out of the 5-min window, still in the hour.
        assert_eq!(t.window(5, m0 + 10 * MINUTE_MS).all.count, 0);
        assert_eq!(t.window(60, m0 + 10 * MINUTE_MS).all.count, 3);
        // An hour and more on: gone.
        for i in 0..70 { t.record("PING", 1, true, m0 + (3 + i) * MINUTE_MS); }
        assert!(t.slots.len() <= TIMING_MINUTES);
        assert_eq!(t.window(60, m0 + 72 * MINUTE_MS).by_type.iter().find(|x| x.kind == "ES"), None);
        // Made-up types: bounded.
        let mut b = MessageTimes::default();
        for i in 0..(MAX_TYPES_PER_MINUTE + 50) { b.record(&format!("T{i}"), 1, true, m0); }
        b.record("lower case", 1, true, m0);
        let w = b.window(1, m0);
        assert_eq!(w.by_type.len(), MAX_TYPES_PER_MINUTE + 1);
        assert_eq!(w.by_type.iter().find(|x| x.kind == OTHER_TYPE).unwrap().count, 51);
    }

    fn s(t: u64) -> Sample {
        Sample { t, ..Default::default() }
    }

    #[test]
    fn the_ring_survives_a_restart_and_forgets_after_a_day() {
        let fx = Fx::new("ring");
        let now = 10 * DAY_MS;
        let mut r = Ring::default();
        r.push(Sample { rss: Some(5), ..s(now - DAY_MS - MINUTE_MS) });
        r.push(Sample { rss: Some(900), oom: Some(0), ..s(now - 3 * 60 * MINUTE_MS) });
        r.push(Sample { rss: Some(300), oom: Some(1), ..s(now - MINUTE_MS) });
        assert_eq!(r.samples.len(), 3, "a day and a minute is still within a day of the newest push");
        r.save(&fx.0, "core").unwrap();
        assert!(fx.0.join("health/core.json").exists());
        let back = Ring::load(&fx.0, "core", now);
        assert_eq!(back.samples.len(), 2, "older than a day at load: dropped");
        assert_eq!(back.peak_rss(now, Some(100)), Some(900));
        assert_eq!(back.oom_kills_24h(now, Some(1)), Some(1));
        assert_eq!(back.oom_kills_24h(now, Some(0)), Some(1), "0 → 1, then a reset to 0 adds nothing");
        // Garbage on disk: an empty day, nothing invented.
        std::fs::write(fx.0.join("health/core.json"), b"{nope").unwrap();
        assert!(Ring::load(&fx.0, "core", now).samples.is_empty());
        // Bounded.
        let mut big = Ring::default();
        for i in 0..(RING_KEEP as u64 + 100) { big.push(s(i * 1000)); }
        assert_eq!(big.samples.len(), RING_KEEP);
    }

    #[test]
    fn oom_resets_and_throttling_and_refusals_from_the_ring() {
        let now = 5 * DAY_MS;
        let mut r = Ring::default();
        r.push(Sample { oom: Some(3), periods: Some(1_000), throttled: Some(100), overloaded: Some(2), queue_timeout: Some(1), ..s(now - 4 * MINUTE_MS) });
        r.push(Sample { oom: Some(0), overloaded: Some(1), queue_timeout: Some(0), ..s(now - 2 * MINUTE_MS) });
        assert_eq!(r.oom_kills_24h(now, Some(2)), Some(2), "3 → 0 is a new container; 0 → 2 is two kills");
        let cur = CpuStat { usage_usec: 0, nr_periods: Some(2_000), nr_throttled: Some(400), throttled_usec: None };
        assert_eq!(r.throttled_pct(now, 5 * MINUTE_MS, Some(&cur)), Some(30.0));
        assert_eq!(r.refusals_within(now, 60 * MINUTE_MS), Some((3, 1)));
        assert_eq!(Ring::default().refusals_within(now, MINUTE_MS), None);
        assert_eq!(cpu_pct(0, 0, 60_000, 30_000_000), Some(50.0));
        assert_eq!(cpu_pct(10, 0, 5, 1), None);
    }

    fn mem(rss: u64, limit: Option<u64>, oom24: u64) -> MemoryFigures {
        MemoryFigures { rss_bytes: Some(rss), limit_bytes: limit, used_pct: limit.map(|l| rss as f64 * 100.0 / l as f64), oom_kills_24h: Some(oom24), ..Default::default() }
    }

    fn inputs<'a>(m: &'a MemoryFigures, c: &'a CpuFigures, w: &'a WorkerView, p: Option<&'a PollerFigures>, d: Option<&'a DiskFigures>) -> CheckInputs<'a> {
        CheckInputs { core_mem: m, core_cpu: c, worker: w, message_p95_ms: Some(20), message_count: 10, refused_5m: Some(0), poller: p, disk: d }
    }

    fn level(checks: &[Check], id: &str) -> Level {
        checks.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no {id}")).level
    }

    #[test]
    fn thresholds_turn_amber_and_red_with_their_fix() {
        let c = CpuFigures { readable: true, throttled_pct_5m: Some(0.0), nr_periods: Some(1), ..Default::default() };
        let w = worker_view("all", Ok(None), 0, "x");
        let g = 1000;
        for (rss, oom, want) in [(790, 0, Level::Ok), (800, 0, Level::Warn), (900, 0, Level::Bad), (100, 1, Level::Bad)] {
            let m = mem(rss, Some(g), oom);
            let ch = evaluate(&inputs(&m, &c, &w, None, None));
            assert_eq!(level(&ch, "core.memory"), want, "{rss} {oom}");
            let line = ch.iter().find(|c| c.id == "core.memory").unwrap();
            assert_eq!(line.fix.is_some(), want != Level::Ok);
            if want != Level::Ok {
                assert!(line.fix.as_deref().unwrap().contains("CORE_MEM_LIMIT"), "{:?}", line.fix);
            }
        }
        let m = mem(1, Some(g), 0);
        for (t, want) in [(9.9, Level::Ok), (10.0, Level::Warn), (30.0, Level::Bad)] {
            let c = CpuFigures { throttled_pct_5m: Some(t), nr_periods: Some(1), ..Default::default() };
            assert_eq!(level(&evaluate(&inputs(&m, &c, &w, None, None)), "core.cpu"), want);
        }
        for (p95, want) in [(999, Level::Ok), (1_000, Level::Warn), (3_000, Level::Bad)] {
            let mut i = inputs(&m, &c, &w, None, None);
            i.message_p95_ms = Some(p95);
            assert_eq!(level(&evaluate(&i), "messages.p95"), want);
        }
        for (n, want) in [(0, Level::Ok), (1, Level::Warn), (20, Level::Bad)] {
            let mut i = inputs(&m, &c, &w, None, None);
            i.refused_5m = Some(n);
            let ch = evaluate(&i);
            assert_eq!(level(&ch, "gate.refused"), want);
            if n > 0 { assert!(ch.iter().find(|c| c.id == "gate.refused").unwrap().fix.as_deref().unwrap().contains("ES_QUEUE_MAX")); }
        }
        for (late, want) in [(4u64, Level::Ok), (5, Level::Warn), (20, Level::Bad)] {
            let p = PollerFigures { enabled: true, tracked: 100, late, late_pct: Some(late as f64), ..Default::default() };
            assert_eq!(level(&evaluate(&inputs(&m, &c, &w, Some(&p), None)), "poller.late"), want);
        }
        let stopped = PollerFigures { enabled: true, stopped: true, late_pct: Some(90.0), ..Default::default() };
        assert_eq!(level(&evaluate(&inputs(&m, &c, &w, Some(&stopped), None)), "poller.late"), Level::Off, "the stop is not lateness");
        for (free, want) in [(16.0, Level::Ok), (15.0, Level::Warn), (5.0, Level::Bad)] {
            let d = DiskFigures { free_pct: Some(free), free_bytes: Some(1), ..Default::default() };
            let ch = evaluate(&inputs(&m, &c, &w, None, Some(&d)));
            assert_eq!(level(&ch, "disk.free"), want);
        }
        assert_eq!(overall(&evaluate(&inputs(&m, &c, &w, None, None))), Level::Ok, "unknown disk does not turn the dot amber");
        let mut i = inputs(&m, &c, &w, None, None);
        i.refused_5m = Some(25);
        assert_eq!(overall(&evaluate(&i)).ping(), "bad");
    }

    #[test]
    fn the_worker_is_not_deployed_missing_late_down_or_mismatched() {
        let now = 1_000_000_000;
        let st = |age_s: u64, v: &str| WorkerStatus { schema: 1, role: "worker".into(), version: v.into(), heartbeat_at: now - age_s * 1000, ..Default::default() };
        let v = worker_view("all", Ok(Some(st(0, "1"))), now, "1");
        assert_eq!((v.state.as_str(), v.level), ("not_deployed", Level::Off));
        assert!(v.text.starts_with("not deployed — role all"));
        assert_eq!(worker_view("core", Ok(None), now, "1").level, Level::Bad);
        assert_eq!(worker_view("core", Err("bad json".into()), now, "1").level, Level::Unknown);
        assert_eq!(worker_view("core", Ok(Some(st(5, "1"))), now, "1").state, "up");
        assert_eq!(worker_view("core", Ok(Some(st(30, "1"))), now, "1").level, Level::Warn);
        assert_eq!(worker_view("core", Ok(Some(st(90, "1"))), now, "1").state, "down");
        let mm = worker_view("core", Ok(Some(st(1, "2"))), now, "1");
        assert_eq!((mm.state.as_str(), mm.level, mm.version_match), ("version", Level::Bad, Some(false)));
        // The worker's own memory is checked once it reports.
        let mut s2 = st(1, "1");
        s2.memory = mem(95, Some(100), 0);
        let w = worker_view("core", Ok(Some(s2)), now, "1");
        let m = mem(1, Some(100), 0);
        let ch = evaluate(&inputs(&m, &CpuFigures::default(), &w, None, None));
        assert_eq!(level(&ch, "worker.memory"), Level::Bad);
        assert!(ch.iter().find(|c| c.id == "worker.memory").unwrap().fix.as_deref().unwrap().contains("ELASTICPRO_WORKER_MEM_LIMIT"));
        // No worker: no worker memory line at all (not "not known").
        let ch = evaluate(&inputs(&m, &CpuFigures::default(), &worker_view("all", Ok(None), now, "1"), None, None));
        assert!(ch.iter().all(|c| c.id != "worker.memory"));
    }

    #[test]
    fn the_worker_status_file_round_trips_and_tolerates_missing_fields() {
        let fx = Fx::new("worker");
        assert_eq!(WorkerStatus::read(&fx.0), Ok(None));
        let st = WorkerStatus { schema: WORKER_STATUS_SCHEMA, role: "worker".into(), version: "0.3.54".into(), started_at: 1, heartbeat_at: 2,
            jobs: vec![JobLine { id: "j1".into(), concurrency: Some(3), ..Default::default() }],
            collection: vec![CollectionLine { cluster_id: "c".into(), kind: "hosts".into(), concurrency: Some(2), ..Default::default() }],
            ..Default::default() };
        st.write(&fx.0).unwrap();
        assert_eq!(WorkerStatus::read(&fx.0).unwrap().as_ref(), Some(&st));
        assert_eq!(st.concurrency(), Some(5));
        fx.put("worker/status.json", r#"{"version":"0.3.55","heartbeatAt":9,"somethingNew":true}"#);
        let r = WorkerStatus::read(&fx.0).unwrap().unwrap();
        assert_eq!((r.version.as_str(), r.heartbeat_at, r.memory.rss_bytes), ("0.3.55", 9, None));
        fx.put("worker/status.json", "{half");
        assert!(WorkerStatus::read(&fx.0).is_err());
    }

    #[test]
    fn jobs_are_read_leniently_with_or_without_concurrency_fields() {
        let q = serde_json::json!({ "jobs": [
            { "id": "a", "kind": "cluster", "clusterId": "c1", "status": "running", "startedAt": 5, "progress": { "done": 2, "total": 9 } },
            { "id": "b", "kind": "mailed", "reportKind": "hosts", "status": "running", "startedAt": 3,
              "progress": { "done": 1, "total": 4, "day": "2026-11-03", "partitions": { "done": 3, "total": 8 }, "pages": 12, "rows": 4000 },
              "concurrency": 2, "halvings": 1, "lastReason": "429 from c2" },
            { "id": "q", "status": "queued", "createdAt": 1 },
            { "id": "d", "status": "done" } ] });
        let (running, queued) = jobs_from(&q);
        assert_eq!(running.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), ["b", "a"], "in the order they started");
        assert_eq!(queued.len(), 1);
        let b = &running[0];
        assert_eq!((b.kind.as_str(), b.day.as_deref(), b.partitions.clone(), b.pages, b.rows), ("hosts", Some("2026-11-03"), Some(Count { done: 3, total: 8 }), Some(12), Some(4000)));
        assert_eq!((b.concurrency, b.halvings, b.last_reason.as_deref()), (Some(2), Some(1), Some("429 from c2")));
        assert_eq!((running[1].concurrency, running[1].progress.clone()), (None, Count { done: 2, total: 9 }));
    }

    #[test]
    fn per_cluster_gate_figures_and_lateness() {
        let now = 10 * MINUTE_MS;
        let recs = [
            UpstreamRec { cluster: "a", at_ms: now - 1000, ms: Some(100), status: Some("200"), sent: true },
            UpstreamRec { cluster: "a", at_ms: now - 2000, ms: Some(9_000), status: Some("timeout"), sent: true },
            UpstreamRec { cluster: "a", at_ms: now - 3000, ms: Some(50), status: Some("429"), sent: true },
            UpstreamRec { cluster: "a", at_ms: now - 3000, ms: Some(1), status: Some("200"), sent: false },
            UpstreamRec { cluster: "b", at_ms: now - 6 * MINUTE_MS, ms: Some(1), status: Some("200"), sent: true },
        ];
        let running = HashMap::from([("c".to_string(), 2)]);
        let waiting = HashMap::from([("c".to_string(), 5)]);
        let g = cluster_gate(&recs, &running, &waiting, now);
        assert_eq!(g.iter().map(|x| x.cluster.as_str()).collect::<Vec<_>>(), ["c", "a"], "waiting first; b's request is older than 5 min");
        let a = &g[1];
        assert_eq!((a.sent_5m, a.timeouts_5m, a.rejected_5m, a.upstream_p95_ms), (3, 1, 1, Some(9_000)));
        let (tracked, due, late, by) = lateness(&[Some(now + 1), Some(now - 10_000), Some(now - 120_000), None], now);
        assert_eq!((tracked, due, late, by), (4, 2, 1, Some(120_000)));
    }

    #[test]
    fn parsers_take_only_what_is_there() {
        assert_eq!(parse_kv("oom 1\noom_kill 4\n", "oom_kill"), Some(4));
        assert_eq!(parse_kv("oom_kill_x 4\n", "oom_kill"), None);
        assert_eq!(parse_cpu_max("200000 100000"), Some(2.0));
        assert_eq!(parse_cpu_max("max"), None);
        assert_eq!(parse_cpu_stat("user_usec 1"), None, "usage_usec is the one that must be there");
        assert_eq!(parse_proc_status("VmRSS:\t12 kB\n"), (Some(12 * 1024), None));
        assert_eq!(role_from(None), "all");
        assert_eq!(role_from(Some(" Worker ")), "worker");
        assert_eq!(role_from(Some("core")), "core");
        assert_eq!(role_from(Some("nonsense")), "all");
    }

    #[test]
    fn disk_areas_are_measured_per_area() {
        let fx = Fx::new("disk");
        fx.put("volume/c1/2026-11.json", &"x".repeat(100));
        fx.put("volume/c1/hosts/2026-11-01.json.gz", &"x".repeat(40));
        fx.put("reports/r.xlsx", &"x".repeat(7));
        fx.put("cache/c1/health.json", &"x".repeat(5));
        fx.put("activity.jsonl", &"x".repeat(3));
        fx.put("activity.jsonl.1", &"x".repeat(2));
        let a = disk_areas(&fx.0);
        let b = |id: &str| a.iter().find(|x| x.id == id).unwrap().bytes;
        assert_eq!((b("volume"), b("hosts"), b("reports"), b("cache"), b("logs")), (Some(100), Some(40), Some(7), Some(5), Some(5)));
        let (bytes, files, cut) = dir_size(&fx.0.join("volume"), 1);
        assert!(cut && bytes <= 140 && files <= 1, "the walk stops at its cap and says so");
        #[cfg(unix)]
        {
            let d = disk_space(&fx.0);
            assert!(d.total_bytes.unwrap() > 0 && d.free_pct.is_some());
        }
    }
}
